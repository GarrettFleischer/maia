//! Owner tags on durable claims.
//!
//! Removing a tag drops it from facts. It does not delete the facts.
//! A tag assignment the owner chose is locked so a later cleanup leaves it.

use maia_core::dream::KnownTag;
use maia_core::dream::TagRole;
use maia_core::dream::names_for_category;
use maia_core::dream::normalize_tag_name;
use maia_core::dream::suggest_tags;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::error::StoreError;
use crate::types::MemoryTag;

/// One change the owner makes to tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryTagChange {
    /// Adds a tag with no facts yet.
    Create {
        /// Name the owner typed.
        name: String,
    },
    /// Changes the visible name. The role stays.
    Rename {
        /// Tag to rename.
        tag_id: String,
        /// New name.
        name: String,
    },
    /// Moves facts onto `keep_id` and removes `drop_id`.
    Merge {
        /// Tag that remains.
        keep_id: String,
        /// Tag that goes away.
        drop_id: String,
    },
    /// Drops the tag from every fact, then deletes the tag.
    Remove {
        /// Tag to remove.
        tag_id: String,
    },
    /// Replaces the tags on one fact and locks that choice.
    Retag {
        /// Claim that keeps its sentence.
        claim_id: String,
        /// Tag names, in primary-first order. Empty clears the tags.
        names: Vec<String>,
    },
}

/// Applies one owner change and leaves claims in place.
pub(crate) fn apply(connection: &Connection, change: &MemoryTagChange) -> Result<(), StoreError> {
    match change {
        MemoryTagChange::Create { name } => {
            let name = require_name(name)?;
            if find_id_by_name(connection, &name)?.is_some() {
                return Err(StoreError::InvalidRequest {
                    message: "that tag already exists".to_owned(),
                });
            }
            let mut known = load_known(connection)?;
            let _ = insert_tag(connection, &name, &mut known)?;
            Ok(())
        }
        MemoryTagChange::Rename { tag_id, name } => rename(connection, tag_id, name),
        MemoryTagChange::Merge { keep_id, drop_id } => merge(connection, keep_id, drop_id),
        MemoryTagChange::Remove { tag_id } => remove(connection, tag_id),
        MemoryTagChange::Retag { claim_id, names } => retag(connection, claim_id, names),
    }
}

/// Tags in role order, then name.
pub(crate) fn list_tags(connection: &Connection) -> Result<Vec<MemoryTag>, StoreError> {
    if !table_ready(connection)? {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT tag_id, name, role FROM memory_tags ORDER BY \
         CASE role WHEN 'people' THEN 0 WHEN 'places' THEN 1 WHEN 'things' THEN 2 \
         WHEN 'ideas' THEN 3 ELSE 4 END, name COLLATE NOCASE",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok(MemoryTag {
            id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
        })
    })?;
    let mut tags = Vec::new();
    for tag in mapped {
        tags.push(tag?);
    }
    Ok(tags)
}

/// Tag names for each claim, primary first.
pub(crate) fn claim_tag_names(
    connection: &Connection,
) -> Result<std::collections::BTreeMap<String, Vec<String>>, StoreError> {
    let mut tags = std::collections::BTreeMap::new();
    if !table_ready(connection)? {
        return Ok(tags);
    }
    let mut statement = connection.prepare(
        "SELECT claim_tags.claim_id, memory_tags.name \
         FROM claim_tags JOIN memory_tags ON memory_tags.tag_id = claim_tags.tag_id \
         ORDER BY claim_tags.claim_id, claim_tags.ordinal, memory_tags.name",
    )?;
    let mapped = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in mapped {
        let (claim_id, name) = row?;
        tags.entry(claim_id).or_insert_with(Vec::new).push(name);
    }
    Ok(tags)
}

/// Gives untagged, unlocked claims a tag. Locked and already tagged claims stay put.
pub(crate) fn fill_empty(connection: &Connection) -> Result<(), StoreError> {
    if !table_ready(connection)? {
        return Ok(());
    }
    let mut statement = connection.prepare(
        "SELECT claims.claim_id, claims.sentence, claims.category \
         FROM claims \
         WHERE claims.tags_locked = 0 \
           AND NOT EXISTS (SELECT 1 FROM claim_tags WHERE claim_tags.claim_id = claims.claim_id)",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    drop(statement);
    for (claim_id, sentence, category) in rows {
        assign_initial(connection, &claim_id, &sentence, &category)?;
    }
    Ok(())
}

/// Tags one new claim unless the owner already locked its tags.
pub(crate) fn fill_claim(
    connection: &Connection,
    claim_id: &str,
    sentence: &str,
    category: &str,
) -> Result<(), StoreError> {
    if !table_ready(connection)? {
        return Ok(());
    }
    let locked: Option<i64> = connection
        .query_row(
            "SELECT tags_locked FROM claims WHERE claim_id = ?1",
            params![claim_id],
            |row| row.get(0),
        )
        .optional()?;
    if locked != Some(0) {
        return Ok(());
    }
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM claim_tags WHERE claim_id = ?1",
        params![claim_id],
        |row| row.get(0),
    )?;
    if count > 0 {
        return Ok(());
    }
    assign_initial(connection, claim_id, sentence, category)
}

fn assign_initial(
    connection: &Connection,
    claim_id: &str,
    sentence: &str,
    category: &str,
) -> Result<(), StoreError> {
    let known = load_known(connection)?;
    let names = names_for_category(category, &known).unwrap_or_else(|| suggest_tags(sentence, &known));
    replace_tags(connection, claim_id, &names, false)
}

fn retag(connection: &Connection, claim_id: &str, names: &[String]) -> Result<(), StoreError> {
    let found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM claims WHERE claim_id = ?1",
            params![claim_id],
            |row| row.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(StoreError::NotFound {
            entity: "claim",
            id: claim_id.to_owned(),
        });
    }
    replace_tags(connection, claim_id, names, true)
}

fn replace_tags(
    connection: &Connection,
    claim_id: &str,
    names: &[String],
    lock: bool,
) -> Result<(), StoreError> {
    let mut known = load_known(connection)?;
    let mut ids = Vec::new();
    for name in names {
        let name = require_name(name)?;
        let id = if let Some(existing) = find_id_by_name(connection, &name)? {
            existing
        } else {
            insert_tag(connection, &name, &mut known)?
        };
        if !ids.iter().any(|item| item == &id) {
            ids.push(id);
        }
    }
    connection.execute("DELETE FROM claim_tags WHERE claim_id = ?1", params![claim_id])?;
    for (ordinal, tag_id) in ids.iter().enumerate() {
        let order = i64::try_from(ordinal).unwrap_or(0);
        connection.execute(
            "INSERT INTO claim_tags (claim_id, tag_id, ordinal) VALUES (?1, ?2, ?3)",
            params![claim_id, tag_id, order],
        )?;
    }
    if lock {
        connection.execute(
            "UPDATE claims SET tags_locked = 1 WHERE claim_id = ?1",
            params![claim_id],
        )?;
    }
    Ok(())
}

fn rename(connection: &Connection, tag_id: &str, name: &str) -> Result<(), StoreError> {
    let name = require_name(name)?;
    require_tag(connection, tag_id)?;
    if let Some(existing) = find_id_by_name(connection, &name)?
        && existing != tag_id
    {
        return Err(StoreError::InvalidRequest {
            message: "that tag already exists".to_owned(),
        });
    }
    connection.execute(
        "UPDATE memory_tags SET name = ?1 WHERE tag_id = ?2",
        params![name, tag_id],
    )?;
    Ok(())
}

fn merge(connection: &Connection, keep_id: &str, drop_id: &str) -> Result<(), StoreError> {
    if keep_id == drop_id || keep_id.is_empty() || drop_id.is_empty() {
        return Err(StoreError::InvalidRequest {
            message: "merge needs two different tags".to_owned(),
        });
    }
    require_tag(connection, keep_id)?;
    require_tag(connection, drop_id)?;
    let mut statement = connection.prepare("SELECT claim_id FROM claim_tags WHERE tag_id = ?1")?;
    let mapped = statement.query_map(params![drop_id], |row| row.get::<_, String>(0))?;
    let mut claims = Vec::new();
    for claim in mapped {
        claims.push(claim?);
    }
    drop(statement);
    connection.execute(
        "INSERT OR IGNORE INTO claim_tags (claim_id, tag_id, ordinal) \
         SELECT claim_id, ?1, ordinal FROM claim_tags WHERE tag_id = ?2",
        params![keep_id, drop_id],
    )?;
    connection.execute("DELETE FROM claim_tags WHERE tag_id = ?1", params![drop_id])?;
    connection.execute("DELETE FROM memory_tags WHERE tag_id = ?1", params![drop_id])?;
    for claim_id in claims {
        connection.execute(
            "UPDATE claims SET tags_locked = 1 WHERE claim_id = ?1",
            params![claim_id],
        )?;
    }
    Ok(())
}

fn remove(connection: &Connection, tag_id: &str) -> Result<(), StoreError> {
    require_tag(connection, tag_id)?;
    let mut statement = connection.prepare("SELECT claim_id FROM claim_tags WHERE tag_id = ?1")?;
    let mapped = statement.query_map(params![tag_id], |row| row.get::<_, String>(0))?;
    let mut claims = Vec::new();
    for claim in mapped {
        claims.push(claim?);
    }
    drop(statement);
    connection.execute("DELETE FROM claim_tags WHERE tag_id = ?1", params![tag_id])?;
    connection.execute("DELETE FROM memory_tags WHERE tag_id = ?1", params![tag_id])?;
    for claim_id in claims {
        connection.execute(
            "UPDATE claims SET tags_locked = 1 WHERE claim_id = ?1",
            params![claim_id],
        )?;
    }
    Ok(())
}

fn insert_tag(connection: &Connection, name: &str, known: &mut Vec<KnownTag>) -> Result<String, StoreError> {
    let role = role_for_name(name, known);
    let id = next_id(connection, name)?;
    connection.execute(
        "INSERT INTO memory_tags (tag_id, name, role, created_at) VALUES (?1, ?2, ?3, 0)",
        params![id, name, role.as_str()],
    )?;
    known.push(KnownTag {
        name: name.to_owned(),
        role,
    });
    Ok(id)
}

fn role_for_name(name: &str, known: &[KnownTag]) -> TagRole {
    for role in [TagRole::People, TagRole::Places, TagRole::Things, TagRole::Ideas] {
        let Some(default_name) = role.default_name() else {
            continue;
        };
        if name.eq_ignore_ascii_case(default_name) && !known.iter().any(|tag| tag.role == role) {
            return role;
        }
    }
    TagRole::Custom
}

fn next_id(connection: &Connection, name: &str) -> Result<String, StoreError> {
    let slug = slug_for(name);
    let base = format!("tag-{slug}");
    let mut candidate = base.clone();
    let mut suffix = 2_i64;
    loop {
        let found: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM memory_tags WHERE tag_id = ?1",
                params![candidate],
                |row| row.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Ok(candidate);
        }
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
}

fn slug_for(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() { "tag".to_owned() } else { slug }
}

fn load_known(connection: &Connection) -> Result<Vec<KnownTag>, StoreError> {
    Ok(list_tags(connection)?
        .into_iter()
        .map(|tag| KnownTag {
            name: tag.name,
            role: TagRole::parse(&tag.role),
        })
        .collect())
}

fn find_id_by_name(connection: &Connection, name: &str) -> Result<Option<String>, StoreError> {
    connection
        .query_row(
            "SELECT tag_id FROM memory_tags WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(StoreError::from)
}

fn require_tag(connection: &Connection, tag_id: &str) -> Result<(), StoreError> {
    let found: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM memory_tags WHERE tag_id = ?1",
            params![tag_id],
            |row| row.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(StoreError::NotFound {
            entity: "tag",
            id: tag_id.to_owned(),
        });
    }
    Ok(())
}

fn require_name(raw: &str) -> Result<String, StoreError> {
    normalize_tag_name(raw).ok_or_else(|| StoreError::InvalidRequest {
        message: "enter a tag name".to_owned(),
    })
}

fn table_ready(connection: &Connection) -> Result<bool, StoreError> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_tags'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|found| found.is_some())
        .map_err(StoreError::from)
}

#[cfg(test)]
mod tests {
    use super::MemoryTagChange;
    use super::apply;
    use super::claim_tag_names;
    use super::fill_empty;
    use super::list_tags;
    use crate::migrate::apply as migrate;
    use crate::vec_register::register_sqlite_vec;
    use rusqlite::Connection;

    fn open() -> Connection {
        register_sqlite_vec().expect("vec");
        let mut connection = Connection::open_in_memory().expect("memory");
        migrate(&mut connection, 1).expect("migrate");
        connection
            .execute(
                "INSERT INTO threads (thread_id, version, participants, created_at) VALUES ('t-1', 1, 'owner', 1)",
                [],
            )
            .expect("thread");
        connection
            .execute(
                "INSERT INTO episodes (episode_id, thread_id, turn_id, body, taint, participants, created_at, write_canonical) \
                 VALUES ('episode-1', 't-1', 'turn-1', 'Owner: hello', 'trusted', 'owner', 1, 'canon')",
                [],
            )
            .expect("episode");
        connection
    }

    fn insert_claim(connection: &Connection, id: &str, sentence: &str, category: &str) {
        connection
            .execute(
                "INSERT INTO claims (claim_id, sentence, episode_id, taint, status, valid_from, category) \
                 VALUES (?1, ?2, 'episode-1', 'trusted', 'provisional', 1, ?3)",
                rusqlite::params![id, sentence, category],
            )
            .expect("claim");
    }

    fn names(connection: &Connection, id: &str) -> Vec<String> {
        claim_tag_names(connection).expect("tags").remove(id).unwrap_or_default()
    }

    #[test]
    fn migration_tags_existing_facts_and_a_later_cleanup_keeps_owner_choices() {
        let connection = open();
        insert_claim(&connection, "claim-name", "The user's name is Garrett.", "person");
        insert_claim(&connection, "claim-city", "The user lives in Canby, Oregon.", "place");
        insert_claim(
            &connection,
            "claim-path",
            "The user has a folder located at F:\\Development\\Ideas.",
            "path",
        );
        insert_claim(&connection, "claim-other", "The user plays chess every Tuesday.", "other");
        fill_empty(&connection).expect("fill");
        assert_eq!(names(&connection, "claim-name"), vec!["People".to_owned()]);
        assert_eq!(names(&connection, "claim-city"), vec!["Places".to_owned()]);
        assert_eq!(names(&connection, "claim-path"), vec!["Things".to_owned()]);
        assert_eq!(names(&connection, "claim-other"), vec!["Chess".to_owned()]);
        assert!(list_tags(&connection).expect("list").iter().any(|tag| tag.name == "Ideas"));
        assert!(list_tags(&connection).expect("list").iter().any(|tag| tag.name == "Chess"));

        apply(
            &connection,
            &MemoryTagChange::Retag {
                claim_id: "claim-city".to_owned(),
                names: vec!["Things".to_owned()],
            },
        )
        .expect("retag");
        fill_empty(&connection).expect("cleanup");
        assert_eq!(names(&connection, "claim-city"), vec!["Things".to_owned()]);

        apply(
            &connection,
            &MemoryTagChange::Rename {
                tag_id: "tag-people".to_owned(),
                name: "Family".to_owned(),
            },
        )
        .expect("rename");
        assert_eq!(names(&connection, "claim-name"), vec!["Family".to_owned()]);

        apply(
            &connection,
            &MemoryTagChange::Merge {
                keep_id: "tag-things".to_owned(),
                drop_id: "tag-ideas".to_owned(),
            },
        )
        .expect("merge");
        assert!(list_tags(&connection).expect("list").iter().all(|tag| tag.name != "Ideas"));

        let before = names(&connection, "claim-name");
        apply(
            &connection,
            &MemoryTagChange::Remove {
                tag_id: "tag-people".to_owned(),
            },
        )
        .expect("remove");
        assert!(names(&connection, "claim-name").is_empty());
        let sentence: String = connection
            .query_row(
                "SELECT sentence FROM claims WHERE claim_id = 'claim-name'",
                [],
                |row| row.get(0),
            )
            .expect("sentence");
        assert_eq!(sentence, "The user's name is Garrett.");
        fill_empty(&connection).expect("cleanup after remove");
        assert!(names(&connection, "claim-name").is_empty());
        assert_eq!(before, vec!["Family".to_owned()]);
    }

    #[test]
    fn the_owner_can_add_a_tag_and_a_blank_name_is_refused() {
        let connection = open();
        apply(
            &connection,
            &MemoryTagChange::Create {
                name: "Dogs".to_owned(),
            },
        )
        .expect("create");
        assert!(list_tags(&connection).expect("list").iter().any(|tag| tag.name == "Dogs"));
        assert!(apply(
            &connection,
            &MemoryTagChange::Create {
                name: "   ".to_owned(),
            },
        )
        .is_err());
    }
}
