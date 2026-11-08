use std::collections::BTreeMap;

use maia_core::agent_tools::{
    AdmitError, AdmittedCatalog, FunctionTool, ToolCaller, computer_tool_names, qualify_tool_name,
    subagent_contract, top_level_entries,
};

#[test]
fn local_catalog_uses_published_names_and_hides_them_from_the_owner_caller() {
    let catalog = AdmittedCatalog::local("PowerShell");
    let json = catalog.tools_json();
    assert!(json.contains("\"name\":\"bash\""));
    for name in computer_tool_names() {
        assert!(catalog.contains(name), "{name}");
        assert!(json.contains(&format!("\"name\":\"{name}\"")), "{name}");
    }
    assert!(json.contains("\"window\""));
    assert!(!json.contains("spawn_task"));
    let text = catalog.owner_text(&[]);
    assert!(text.contains("cannot call"));
    assert!(text.contains("screenshot"));
    assert!(matches!(
        catalog.admit(ToolCaller::Owner, "bash", "{\"command\":\"Get-Date\"}"),
        Err(AdmitError::OwnerForbidden)
    ));
}

#[test]
fn bash_requires_a_command_unless_restart_is_true() {
    let catalog = AdmittedCatalog::local("PowerShell");
    assert!(
        catalog
            .admit(ToolCaller::Subagent, "bash", "{\"command\":\"Get-Date\"}")
            .is_ok()
    );
    assert!(
        catalog
            .admit(ToolCaller::Subagent, "bash", "{\"restart\":true}")
            .is_ok()
    );
    assert!(matches!(
        catalog.admit(ToolCaller::Subagent, "bash", "{}"),
        Err(AdmitError::MissingRequired { name }) if name == "command"
    ));
}

#[test]
fn screenshot_accepts_a_window_and_zoom_requires_a_region() {
    let catalog = AdmittedCatalog::local("PowerShell");
    assert!(
        catalog
            .admit(
                ToolCaller::Subagent,
                "screenshot",
                "{\"window\":\"Notepad\"}"
            )
            .is_ok()
    );
    assert!(
        catalog
            .admit(ToolCaller::Subagent, "screenshot", "{}")
            .is_ok()
    );
    assert!(matches!(
        catalog.admit(ToolCaller::Subagent, "zoom", "{}"),
        Err(AdmitError::MissingRequired { name }) if name == "region"
    ));
    assert!(
        catalog
            .admit(
                ToolCaller::Subagent,
                "zoom",
                "{\"region\":[0,0,20,20]}"
            )
            .is_ok()
    );
}

#[test]
fn remote_tool_keeps_its_name_until_that_name_is_taken() {
    let mut catalog = AdmittedCatalog::local("PowerShell");
    catalog
        .insert_remote(
            "playwright",
            FunctionTool {
                name: "browser_navigate".to_owned(),
                description: "Navigate to a URL".to_owned(),
                parameters_json: "{\"type\":\"object\",\"properties\":{}}".to_owned(),
                required: Vec::new(),
            },
        )
        .expect("browser tool");
    assert!(catalog.contains("browser_navigate"));
    catalog
        .insert_remote(
            "other",
            FunctionTool {
                name: "screenshot".to_owned(),
                description: "Remote shot".to_owned(),
                parameters_json: "{\"type\":\"object\",\"properties\":{}}".to_owned(),
                required: Vec::new(),
            },
        )
        .expect("qualified");
    assert!(catalog.contains("other__screenshot"));
    assert!(catalog.contains("screenshot"));
    let mut taken = BTreeMap::new();
    taken.insert(
        "screenshot".to_owned(),
        FunctionTool {
            name: "screenshot".to_owned(),
            description: String::new(),
            parameters_json: "{}".to_owned(),
            required: Vec::new(),
        },
    );
    assert_eq!(
        qualify_tool_name("other", "screenshot", &taken),
        "other__screenshot"
    );
}

#[test]
fn object_entries_ignore_nested_keys() {
    let entries = top_level_entries("{\"window\":\"{\\\"nested\\\":1}\",\"ok\":true}")
        .expect("object");
    assert_eq!(entries[0].0, "window");
    assert_eq!(entries[1], ("ok".to_owned(), "true".to_owned()));
}

#[test]
fn subagent_contract_names_the_host_shell() {
    let contract = subagent_contract("PowerShell");
    assert!(contract.contains("PowerShell"));
    assert!(contract.contains("screenshot"));
    assert!(contract.contains("Playwright"));
}
