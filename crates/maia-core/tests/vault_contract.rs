use maia_core::vault::{
    EntityFact, FrontmatterIssue, NoteHeader, NoteKind, VaultError, neutralize_inline_markdown,
    parse_note, render_entity_page, render_index,
};

#[test]
fn parse_note_returns_strict_metadata_and_exact_body_bytes() {
    let bytes = concat!(
        "---\n",
        "id: entity_maia\n",
        "description: The local agentic operating system.\n",
        "see:\n",
        "  - \"[[agents/scout/index]]\"\n",
        "  - \"[[world/entities/obsidian]]\"\n",
        "kind: entity\n",
        "---\n",
        "First line.\r\n",
        "Second line with trailing spaces.  \r\n",
    )
    .as_bytes();

    let note = parse_note(bytes).expect("the valid fixture should parse");

    assert_eq!(note.frontmatter.id, "entity_maia");
    assert_eq!(
        note.frontmatter.description,
        "The local agentic operating system."
    );
    assert_eq!(
        note.frontmatter.see,
        ["agents/scout/index", "world/entities/obsidian"]
    );
    assert_eq!(note.frontmatter.kind, NoteKind::Entity);
    assert_eq!(
        note.body,
        b"First line.\r\nSecond line with trailing spaces.  \r\n"
    );
}

#[test]
fn parse_note_rejects_each_forbidden_frontmatter_shape() {
    let cases = [
        (
            "missing field",
            "---\nid: root\ndescription: Root.\nsee: []\n---\n",
            FrontmatterIssue::MissingField,
        ),
        (
            "duplicate key",
            "---\nid: root\nid: other\ndescription: Root.\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::DuplicateKey,
        ),
        (
            "unknown key",
            "---\nid: root\ndescription: Root.\nsee: []\nkind: root\nextra: value\n---\n",
            FrontmatterIssue::UnknownField,
        ),
        (
            "folded description",
            "---\nid: root\ndescription: >\n  Root.\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "yaml alias",
            "---\nid: &id root\ndescription: Root.\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "custom tag",
            "---\nid: !tag root\ndescription: Root.\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "unknown kind",
            "---\nid: root\ndescription: Root.\nsee: []\nkind: mystery\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "escaping link",
            "---\nid: root\ndescription: Root.\nsee:\n  - \"[[../outside]]\"\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "absolute link",
            "---\nid: root\ndescription: Root.\nsee:\n  - \"[[C:/outside]]\"\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "link with suffix",
            "---\nid: root\ndescription: Root.\nsee:\n  - \"[[note.md]]\"\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "empty quoted description",
            "---\nid: root\ndescription: \"\"\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
        (
            "escaped multiline description",
            "---\nid: root\ndescription: \"first\\nsecond\"\nsee: []\nkind: root\n---\n",
            FrontmatterIssue::InvalidValue,
        ),
    ];

    for (name, fixture, expected_issue) in cases {
        let error = parse_note(fixture.as_bytes()).expect_err(name);

        assert_eq!(
            error,
            VaultError::InvalidFrontmatter(expected_issue),
            "fixture: {name}"
        );
    }
}

#[test]
fn parse_note_accepts_plain_text_punctuation() {
    let note = parse_note(b"---\nid: root\ndescription: Great!\nsee: []\nkind: root\n---\n")
        .expect("plain punctuation is not a YAML custom tag");
    assert_eq!(note.frontmatter.description, "Great!");
}

#[test]
fn parse_note_rejects_bom_and_invalid_utf8() {
    let bom = b"\xEF\xBB\xBF---\nid: root\ndescription: Root.\nsee: []\nkind: root\n---\n";
    let invalid_utf8 = b"---\nid: root\ndescription: \xFF\nsee: []\nkind: root\n---\n";

    assert_eq!(parse_note(bom), Err(VaultError::InvalidEncoding));
    assert_eq!(parse_note(invalid_utf8), Err(VaultError::InvalidEncoding));
}

#[test]
fn render_index_sorts_by_normalized_link_and_exposes_only_header_data() {
    let children = [
        NoteHeader {
            link: "world/entities/obsidian".to_owned(),
            description: "A local Markdown knowledge-base application.".to_owned(),
        },
        NoteHeader {
            link: "world/entities/maia".to_owned(),
            description: "The local agentic operating system.".to_owned(),
        },
    ];

    let rendered = render_index(&children);

    assert_eq!(
        rendered,
        concat!(
            "- [[world/entities/maia]] — The local agentic operating system.\n",
            "- [[world/entities/obsidian]] — A local Markdown knowledge-base application.\n",
        )
    );
}

#[test]
fn render_index_neutralizes_wikilink_in_description() {
    let children = [NoteHeader {
        link: "world/entities/maia".to_owned(),
        description: "See [[evil/inject]] and <script>.".to_owned(),
    }];

    let rendered = render_index(&children);

    assert!(
        !rendered.contains("[[evil") && !rendered.contains("<script>"),
        "generated index must neutralize descriptions: {rendered:?}"
    );
    assert!(rendered.contains("［［evil/inject]]"));
}

#[test]
fn render_entity_page_preserves_human_bytes_and_sorts_neutralized_facts() {
    let existing = concat!(
        "---\n",
        "id: entity_obsidian\n",
        "description: Obsidian.\n",
        "see: []\n",
        "kind: entity\n",
        "---\n",
        "<!-- maia:generated:start -->\n",
        "- `fact_old`: Old text.\n",
        "<!-- maia:generated:end -->\n",
        "<!-- maia:human:start -->\n",
        "## Notes\r\n",
        "\r\n",
        "Keep local plugins minimal.  \r\n",
        "<!-- maia:human:end -->\n",
    );
    let facts = [
        EntityFact {
            id: "fact_02".to_owned(),
            sentence: "Avoid <script> and [[unsafe links]].".to_owned(),
        },
        EntityFact {
            id: "fact_01".to_owned(),
            sentence: "Obsidian opens Maia's vault.".to_owned(),
        },
    ];

    let rendered =
        render_entity_page(existing, &facts).expect("the valid entity fixture should render");

    assert!(rendered.contains(
        "<!-- maia:generated:start -->\n\
         - `fact_01`: Obsidian opens Maia's vault.\n\
         - `fact_02`: Avoid ‹script> and ［［unsafe links]].\n\
         <!-- maia:generated:end -->"
    ));
    assert!(rendered.ends_with(
        "<!-- maia:human:start -->\n\
         ## Notes\r\n\
         \r\n\
         Keep local plugins minimal.  \r\n\
         <!-- maia:human:end -->\n"
    ));
}

#[test]
fn render_entity_page_rejects_malformed_or_duplicate_markers() {
    let malformed = [
        "plain note",
        "<!-- maia:generated:start -->\n<!-- maia:generated:end -->",
        concat!(
            "<!-- maia:generated:start -->\n",
            "<!-- maia:generated:start -->\n",
            "<!-- maia:generated:end -->\n",
            "<!-- maia:human:start -->\n",
            "<!-- maia:human:end -->\n",
        ),
        concat!(
            "<!-- maia:generated:end -->\n",
            "<!-- maia:generated:start -->\n",
            "<!-- maia:human:start -->\n",
            "<!-- maia:human:end -->\n",
        ),
        concat!(
            "<!-- maia:generated:start -->\n",
            "<!-- maia:generated:end -->\n",
            "<!-- maia:generated:end -->\n",
            "<!-- maia:human:start -->\n",
            "<!-- maia:human:end -->\n",
        ),
        concat!(
            "<!-- maia:human:end -->\n",
            "<!-- maia:generated:start -->\n",
            "<!-- maia:generated:end -->\n",
            "<!-- maia:human:start -->\n",
            "<!-- maia:human:end -->\n",
        ),
    ];

    for fixture in malformed {
        assert!(
            render_entity_page(fixture, &[]).is_err(),
            "fixture should fail: {fixture:?}"
        );
    }
}

#[test]
fn neutralize_inline_markdown_removes_every_forbidden_construct() {
    let unsafe_text = concat!(
        "[[wikilink]] ![[embed]] ![image](https://example.com) ](target) ",
        "<http://example.com> <% script %> %% hidden %% ",
        "<!-- maia:generated:start --> ```code``` ",
        "obsidian:open file:///tmp javascript:alert(1) data:text/html,x ",
        "\\\\server\\share \u{202e}reversed",
    );

    let safe = neutralize_inline_markdown(unsafe_text);

    for forbidden in [
        "[[",
        "![",
        "](",
        "<",
        "<%",
        "%%",
        "<!-- maia:",
        "```",
        "obsidian:",
        "file:",
        "javascript:",
        "data:",
        "\\\\",
        "\u{202e}",
    ] {
        assert!(
            !safe.to_ascii_lowercase().contains(forbidden),
            "forbidden construct survived: {forbidden:?} in {safe:?}"
        );
    }
}
