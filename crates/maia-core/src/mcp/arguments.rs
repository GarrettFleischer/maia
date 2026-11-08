use serde_json::Value;

/// Why tool arguments missed the pinned schema subset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgumentError {
    /// The arguments are not a JSON object matching the checked schema subset.
    Invalid,
}

/// Checks the top-level object rules of an admitted schema.
///
/// # Errors
///
/// Returns [`ArgumentError::Invalid`] when the subset fails.
pub fn check_arguments(schema_json: &str, arguments_json: &str) -> Result<(), ArgumentError> {
    let schema = if schema_json.trim().is_empty() || schema_json.trim() == "null" {
        Value::Null
    } else {
        serde_json::from_str(schema_json).map_err(|_| ArgumentError::Invalid)?
    };
    let arguments: Value =
        serde_json::from_str(arguments_json).map_err(|_| ArgumentError::Invalid)?;
    let Value::Object(arguments) = arguments else {
        return Err(ArgumentError::Invalid);
    };
    let (properties, required, additional_closed) = schema_rules(&schema)?;
    for name in required {
        if !arguments.contains_key(name) {
            return Err(ArgumentError::Invalid);
        }
    }
    for (key, value) in &arguments {
        if additional_closed && !properties.iter().any(|(name, _)| name == key) {
            return Err(ArgumentError::Invalid);
        }
        if let Some((_, property)) = properties.iter().find(|(name, _)| name == key)
            && !value_matches(property, value)
        {
            return Err(ArgumentError::Invalid);
        }
    }
    Ok(())
}

/// Sorted top-level property names, or an empty list when the schema is not an object.
///
/// # Errors
///
/// Returns [`ArgumentError::Invalid`] when the schema text is not JSON.
pub fn parameter_names(schema_json: &str) -> Result<Vec<String>, ArgumentError> {
    let schema: Value = serde_json::from_str(schema_json).map_err(|_| ArgumentError::Invalid)?;
    let Value::Object(schema) = schema else {
        return Ok(Vec::new());
    };
    let Some(Value::Object(properties)) = schema.get("properties") else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = properties.keys().cloned().collect();
    names.sort();
    Ok(names)
}

type SchemaRules<'a> = Result<(Vec<(&'a str, &'a Value)>, Vec<&'a str>, bool), ArgumentError>;

fn schema_rules(schema: &Value) -> SchemaRules<'_> {
    if schema.is_null() {
        return Ok((Vec::new(), Vec::new(), false));
    }
    let Value::Object(schema) = schema else {
        return Err(ArgumentError::Invalid);
    };
    if let Some(kind) = schema.get("type")
        && kind.as_str() != Some("object")
    {
        return Err(ArgumentError::Invalid);
    }
    let mut properties = Vec::new();
    if let Some(Value::Object(map)) = schema.get("properties") {
        for (name, value) in map {
            properties.push((name.as_str(), value));
        }
    }
    let mut required = Vec::new();
    if let Some(Value::Array(items)) = schema.get("required") {
        for item in items {
            let Some(name) = item.as_str() else {
                return Err(ArgumentError::Invalid);
            };
            required.push(name);
        }
    }
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    Ok((properties, required, closed))
}

fn value_matches(property: &Value, value: &Value) -> bool {
    let Some(kind) = property.get("type").and_then(Value::as_str) else {
        return true;
    };
    match kind {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_number().is_some_and(is_integer),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    }
}

fn is_integer(number: &serde_json::Number) -> bool {
    if number.as_i64().is_some() || number.as_u64().is_some() {
        return true;
    }
    number
        .as_f64()
        .is_some_and(|value| value.is_finite() && value.fract() == 0.0)
}
