//! Tags for durable facts.
//!
//! A fact can carry more than one tag. These functions only read their arguments.

/// A tag the owner already has, including the four starting tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownTag {
    /// Name shown in Memory.
    pub name: String,
    /// What new facts of this kind should use.
    pub role: TagRole,
}

/// Why a tag exists. Renaming keeps the role so new facts still land there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagRole {
    /// A person, including the owner.
    People,
    /// A city, region, or other place.
    Places,
    /// A folder, device, project, or other object.
    Things,
    /// A preference or standing instruction.
    Ideas,
    /// A tag the owner added, or one invented for a fact that fit nothing else.
    Custom,
}

impl TagRole {
    /// Stable role name stored beside the tag.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::People => "people",
            Self::Places => "places",
            Self::Things => "things",
            Self::Ideas => "ideas",
            Self::Custom => "custom",
        }
    }

    /// Role stored in the database.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value {
            "people" => Self::People,
            "places" => Self::Places,
            "things" => Self::Things,
            "ideas" => Self::Ideas,
            _ => Self::Custom,
        }
    }

    /// Name used when this role has no tag yet.
    #[must_use]
    pub const fn default_name(self) -> Option<&'static str> {
        match self {
            Self::People => Some("People"),
            Self::Places => Some("Places"),
            Self::Things => Some("Things"),
            Self::Ideas => Some("Ideas"),
            Self::Custom => None,
        }
    }
}

/// The four tags Memory starts with.
#[must_use]
pub fn default_tags() -> Vec<KnownTag> {
    [TagRole::People, TagRole::Places, TagRole::Things, TagRole::Ideas]
        .into_iter()
        .map(|role| KnownTag {
            name: role.default_name().unwrap_or("Notes").to_owned(),
            role,
        })
        .collect()
}

/// Tags for a new fact. Uses an existing tag when it fits, and a new name when it does not.
#[must_use]
pub fn suggest_tags(sentence: &str, known: &[KnownTag]) -> Vec<String> {
    let mut names = Vec::new();
    for role in matching_roles(sentence) {
        push_unique(&mut names, name_for_role(role, known));
    }
    for tag in known {
        if tag.role == TagRole::Custom && mentions(sentence, &tag.name) {
            push_unique(&mut names, tag.name.clone());
        }
    }
    if names.is_empty() {
        names.push(invent_tag(sentence));
    }
    names
}

/// Tag names for a category saved before tags existed.
///
/// `other` and an empty category return nothing, so the caller asks [`suggest_tags`].
#[must_use]
pub fn names_for_category(category: &str, known: &[KnownTag]) -> Option<Vec<String>> {
    let role = match category {
        "person" => TagRole::People,
        "place" => TagRole::Places,
        "project" | "path" | "device" => TagRole::Things,
        "preference" | "decision" => TagRole::Ideas,
        _ => return None,
    };
    Some(vec![name_for_role(role, known)])
}

/// Trims a tag name. Empty and over-long names are rejected.
#[must_use]
pub fn normalize_tag_name(raw: &str) -> Option<String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
        return None;
    }
    Some(name)
}

/// Claims and facts sort ahead of conversation snippets. Equal kinds keep their order.
#[must_use]
pub fn search_kind_rank(kind: &str) -> u8 {
    match kind {
        "claim" | "fact" => 0,
        _ => 1,
    }
}

fn name_for_role(role: TagRole, known: &[KnownTag]) -> String {
    known
        .iter()
        .find(|tag| tag.role == role)
        .map(|tag| tag.name.clone())
        .or_else(|| role.default_name().map(str::to_owned))
        .unwrap_or_else(|| "Notes".to_owned())
}

fn matching_roles(sentence: &str) -> Vec<TagRole> {
    let folded = sentence.to_lowercase();
    let path = folded.contains(":\\") || folded.contains("://") || folded.contains("folder");
    let mut roles = Vec::new();
    if folded.contains("name is")
        || folded.contains(" is named ")
        || folded.contains("'s name")
        || folded.contains("’s name")
    {
        roles.push(TagRole::People);
    }
    if !path
        && (folded.contains("lives in") || folded.contains("moved to") || folded.contains("located in"))
    {
        roles.push(TagRole::Places);
    }
    if path
        || folded.contains("phone")
        || folded.contains("pixel")
        || folded.contains("laptop")
        || folded.contains("computer")
        || folded.contains("device")
        || folded.contains("project")
    {
        roles.push(TagRole::Things);
    }
    if folded.contains("prefer")
        || folded.contains("likes")
        || folded.contains("wants")
        || folded.contains("always")
        || folded.contains("never")
        || folded.contains("instruction")
        || folded.contains("favorite")
    {
        roles.push(TagRole::Ideas);
    }
    roles
}

fn invent_tag(sentence: &str) -> String {
    let words = words(sentence);
    if let Some(name) = proper_phrase(&words)
        && let Some(name) = normalize_tag_name(&name)
    {
        return name;
    }
    let content = content_words(&words);
    if let Some(word) = content.last()
        && let Some(name) = normalize_tag_name(&title_word(word))
    {
        return name;
    }
    "Notes".to_owned()
}

fn proper_phrase(words: &[&str]) -> Option<String> {
    let mut phrase = Vec::new();
    for word in words {
        if starts_upper(word) && !is_weekday(word) && !is_skip(word) && !is_verb(word) {
            phrase.push(*word);
            continue;
        }
        if !phrase.is_empty() {
            break;
        }
    }
    if phrase.is_empty() {
        None
    } else {
        Some(phrase.join(" "))
    }
}

fn content_words<'a>(words: &'a [&str]) -> Vec<&'a str> {
    words
        .iter()
        .copied()
        .filter(|word| word.len() > 3 && !is_skip(word) && !is_weekday(word) && !is_verb(word))
        .collect()
}

fn mentions(sentence: &str, name: &str) -> bool {
    let needle = name.trim().to_lowercase();
    if needle.chars().count() < 3 {
        return false;
    }
    let folded = sentence.to_lowercase();
    let parts: Vec<&str> = needle.split_whitespace().collect();
    let words = words(&folded);
    words.windows(parts.len()).any(|window| window == parts.as_slice())
}

fn words(sentence: &str) -> Vec<&str> {
    sentence
        .split(|ch: char| !ch.is_alphanumeric() && ch != '\'')
        .filter(|word| !word.is_empty())
        .collect()
}

fn push_unique(names: &mut Vec<String>, name: String) {
    if !names.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
        names.push(name);
    }
}

fn starts_upper(word: &str) -> bool {
    word.chars().next().is_some_and(char::is_uppercase)
}

fn title_word(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

fn is_weekday(word: &str) -> bool {
    matches!(
        word.to_lowercase().as_str(),
        "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
    )
}

fn is_verb(word: &str) -> bool {
    matches!(
        word.to_lowercase().as_str(),
        "plays" | "play" | "played" | "collects" | "uses" | "using" | "handed"
    )
}

fn is_skip(word: &str) -> bool {
    matches!(
        word.to_lowercase().as_str(),
        "the"
            | "user"
            | "owner"
            | "garrett"
            | "and"
            | "or"
            | "a"
            | "an"
            | "is"
            | "are"
            | "was"
            | "were"
            | "has"
            | "have"
            | "had"
            | "of"
            | "to"
            | "in"
            | "on"
            | "for"
            | "with"
            | "that"
            | "this"
            | "their"
            | "his"
            | "her"
            | "every"
            | "from"
            | "into"
            | "about"
            | "your"
    )
}

#[cfg(test)]
mod tests {
    use super::KnownTag;
    use super::TagRole;
    use super::default_tags;
    use super::names_for_category;
    use super::normalize_tag_name;
    use super::search_kind_rank;
    use super::suggest_tags;

    #[test]
    fn owner_facts_land_on_the_starting_tags() {
        let known = default_tags();
        assert_eq!(
            suggest_tags("The user's name is Garrett.", &known),
            vec!["People".to_owned()]
        );
        assert_eq!(
            suggest_tags("The user lives in Canby, Oregon.", &known),
            vec!["Places".to_owned()]
        );
        assert_eq!(
            suggest_tags(
                "The user has a folder located at F:\\Development\\Ideas.",
                &known
            ),
            vec!["Things".to_owned()]
        );
        assert_eq!(
            suggest_tags("The user prefers short replies.", &known),
            vec!["Ideas".to_owned()]
        );
        assert_eq!(
            suggest_tags("Always ask before deleting files.", &known),
            vec!["Ideas".to_owned()]
        );
        assert_eq!(
            suggest_tags("The user has a Pixel phone.", &known),
            vec!["Things".to_owned()]
        );
    }

    #[test]
    fn a_renamed_role_tag_is_reused_and_a_missing_one_comes_back() {
        let family = vec![KnownTag {
            name: "Family".to_owned(),
            role: TagRole::People,
        }];
        assert_eq!(
            suggest_tags("The user's name is Garrett.", &family),
            vec!["Family".to_owned()]
        );
        assert_eq!(
            suggest_tags("The user's name is Garrett.", &[]),
            vec!["People".to_owned()]
        );
    }

    #[test]
    fn a_fact_that_fits_nothing_gets_a_new_tag_instead_of_a_catch_all() {
        let known = default_tags();
        assert_eq!(
            suggest_tags("The user plays chess every Tuesday.", &known),
            vec!["Chess".to_owned()]
        );
        let with_chess = {
            let mut tags = known.clone();
            tags.push(KnownTag {
                name: "Chess".to_owned(),
                role: TagRole::Custom,
            });
            tags
        };
        assert_eq!(
            suggest_tags("The user plays chess every Tuesday.", &with_chess),
            vec!["Chess".to_owned()]
        );
        assert_eq!(
            suggest_tags("Pepper sleeps on the porch.", &known),
            vec!["Pepper".to_owned()]
        );
        assert_eq!(
            suggest_tags("Handed this message to the running task.", &known),
            vec!["Task".to_owned()]
        );
        assert!(!suggest_tags("The user plays chess every Tuesday.", &known)
            .iter()
            .any(|name| name.eq_ignore_ascii_case("other") || name == "About you"));
    }

    #[test]
    fn one_sentence_can_carry_more_than_one_tag() {
        assert_eq!(
            suggest_tags(
                "The user lives in Canby and prefers rain.",
                &default_tags()
            ),
            vec!["Places".to_owned(), "Ideas".to_owned()]
        );
    }

    #[test]
    fn stored_categories_map_onto_tags_and_other_does_not() {
        let known = default_tags();
        assert_eq!(names_for_category("person", &known), Some(vec!["People".to_owned()]));
        assert_eq!(names_for_category("place", &known), Some(vec!["Places".to_owned()]));
        assert_eq!(names_for_category("path", &known), Some(vec!["Things".to_owned()]));
        assert_eq!(names_for_category("device", &known), Some(vec!["Things".to_owned()]));
        assert_eq!(names_for_category("preference", &known), Some(vec!["Ideas".to_owned()]));
        assert_eq!(names_for_category("decision", &known), Some(vec!["Ideas".to_owned()]));
        assert_eq!(names_for_category("other", &known), None);
        assert_eq!(names_for_category("", &known), None);
        let family = vec![KnownTag {
            name: "Family".to_owned(),
            role: TagRole::People,
        }];
        assert_eq!(names_for_category("person", &family), Some(vec!["Family".to_owned()]));
    }

    #[test]
    fn blank_tag_names_are_rejected_and_facts_sort_ahead_of_conversations() {
        assert_eq!(normalize_tag_name("  People  "), Some("People".to_owned()));
        assert_eq!(normalize_tag_name("   "), None);
        assert_eq!(normalize_tag_name(&"x".repeat(41)), None);
        assert!(search_kind_rank("claim") < search_kind_rank("episode"));
        assert!(search_kind_rank("fact") < search_kind_rank("episode"));
        assert_eq!(search_kind_rank("claim"), search_kind_rank("fact"));
    }
}
