//! Published computer-use member calls.
//!
//! The names and inputs follow the computer toolset. `screenshot` also accepts
//! `window` so one app can be captured.

use serde_json::Value;

/// One desktop action after argument checks.
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopCall {
    /// Whole display, or one window when `window` is set.
    Screenshot {
        /// Process name or window title.
        window: Option<String>,
    },
    /// One pixel region.
    Zoom {
        /// Left.
        x0: i32,
        /// Top.
        y0: i32,
        /// Right.
        x1: i32,
        /// Bottom.
        y1: i32,
    },
    /// A mouse button click.
    Click {
        /// `left`, `right`, or `middle`.
        button: &'static str,
        /// Click count.
        count: u32,
        /// Screen point. Omitted means the current pointer.
        at: Option<(i32, i32)>,
        /// Modifier chord.
        modifiers: String,
    },
    /// Press, drag, and release.
    Drag {
        /// Start point.
        start: (i32, i32),
        /// End point.
        end: (i32, i32),
        /// Modifier chord.
        modifiers: String,
    },
    /// Move the pointer.
    Move {
        /// Screen point.
        at: (i32, i32),
    },
    /// Press the left button.
    LeftDown,
    /// Release the left button.
    LeftUp,
    /// Read the pointer.
    Cursor,
    /// Scroll at a point.
    Scroll {
        /// `up`, `down`, `left`, or `right`.
        direction: String,
        /// Wheel clicks.
        amount: i32,
        /// Screen point.
        at: Option<(i32, i32)>,
        /// Modifier chord.
        modifiers: String,
    },
    /// Type literal text.
    Type {
        /// Text.
        text: String,
    },
    /// Press a key chord.
    Key {
        /// Chord such as `ctrl+s`.
        text: String,
        /// Repeat count from 1 to 100.
        repeat: u32,
    },
    /// Hold a chord.
    Hold {
        /// Chord.
        text: String,
        /// Seconds, at most 300.
        duration: f64,
    },
    /// Pause.
    Wait {
        /// Seconds, at most 300.
        duration: f64,
    },
}

/// Result of one desktop action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopOutcome {
    /// Text for the model.
    Text(String),
    /// PNG bytes plus a short note.
    Png {
        /// Note.
        note: String,
        /// PNG file bytes.
        bytes: Vec<u8>,
    },
}

/// Parses a computer-use member call.
pub fn parse_desktop_call(name: &str, arguments_json: &str) -> Result<DesktopCall, String> {
    let value: Value = serde_json::from_str(arguments_json)
        .map_err(|_| "Computer arguments must be a JSON object.".to_owned())?;
    let Value::Object(_) = &value else {
        return Err("Computer arguments must be a JSON object.".to_owned());
    };
    match name {
        "screenshot" => Ok(DesktopCall::Screenshot {
            window: optional_string(&value, "window")?,
        }),
        "zoom" => {
            let region = pair4(required_array(&value, "region")?)?;
            Ok(DesktopCall::Zoom {
                x0: region.0,
                y0: region.1,
                x1: region.2,
                y1: region.3,
            })
        }
        "left_click" => click("left", 1, &value),
        "right_click" => click("right", 1, &value),
        "middle_click" => click("middle", 1, &value),
        "double_click" => click("left", 2, &value),
        "triple_click" => click("left", 3, &value),
        "left_click_drag" => Ok(DesktopCall::Drag {
            start: pair2(required_array(&value, "start_coordinate")?)?,
            end: pair2(required_array(&value, "coordinate")?)?,
            modifiers: optional_string(&value, "text")?.unwrap_or_default(),
        }),
        "mouse_move" => Ok(DesktopCall::Move {
            at: pair2(required_array(&value, "coordinate")?)?,
        }),
        "left_mouse_down" => Ok(DesktopCall::LeftDown),
        "left_mouse_up" => Ok(DesktopCall::LeftUp),
        "cursor_position" => Ok(DesktopCall::Cursor),
        "scroll" => Ok(DesktopCall::Scroll {
            direction: required_string(&value, "scroll_direction")?,
            amount: optional_i32(&value, "scroll_amount")?.unwrap_or(3),
            at: optional_pair(&value, "coordinate")?,
            modifiers: optional_string(&value, "text")?.unwrap_or_default(),
        }),
        "type" => Ok(DesktopCall::Type {
            text: required_string(&value, "text")?,
        }),
        "key" => {
            let repeat = optional_i32(&value, "repeat")?.unwrap_or(1);
            if !(1..=100).contains(&repeat) {
                return Err("key repeat must be from 1 to 100.".to_owned());
            }
            Ok(DesktopCall::Key {
                text: required_string(&value, "text")?,
                repeat: u32::try_from(repeat).unwrap_or(1),
            })
        }
        "hold_key" => Ok(DesktopCall::Hold {
            text: required_string(&value, "text")?,
            duration: duration(&value)?,
        }),
        "wait" => Ok(DesktopCall::Wait {
            duration: duration(&value)?,
        }),
        _ => Err(format!("{name} is not a computer tool.")),
    }
}

/// Runs one parsed desktop call on this machine.
pub fn run_desktop(call: &DesktopCall) -> Result<DesktopOutcome, String> {
    #[cfg(windows)]
    {
        run_windows(call)
    }
    #[cfg(not(windows))]
    {
        let _ = call;
        Err("Desktop computer use is available on Windows.".to_owned())
    }
}

#[cfg(windows)]
fn run_windows(call: &DesktopCall) -> Result<DesktopOutcome, String> {
    let failed = |error: maia_windows::DesktopError| error.to_string();
    match call {
        DesktopCall::Screenshot { window } => {
            let bytes = maia_windows::capture_display(window.as_deref()).map_err(failed)?;
            Ok(DesktopOutcome::Png {
                note: match window {
                    Some(title) => format!("Captured the window {title}."),
                    None => "Captured the whole display.".to_owned(),
                },
                bytes,
            })
        }
        DesktopCall::Zoom { x0, y0, x1, y1 } => {
            let bytes = maia_windows::capture_region(*x0, *y0, *x1, *y1).map_err(failed)?;
            Ok(DesktopOutcome::Png {
                note: format!("Captured the region {x0},{y0} to {x1},{y1}."),
                bytes,
            })
        }
        DesktopCall::Click {
            button,
            count,
            at,
            modifiers,
        } => {
            maia_windows::pointer_click(button, *count, *at, modifiers).map_err(failed)?;
            Ok(DesktopOutcome::Text("Clicked.".to_owned()))
        }
        DesktopCall::Drag {
            start,
            end,
            modifiers,
        } => {
            maia_windows::pointer_drag(*start, *end, modifiers).map_err(failed)?;
            Ok(DesktopOutcome::Text("Dragged.".to_owned()))
        }
        DesktopCall::Move { at } => {
            maia_windows::pointer_move(*at).map_err(failed)?;
            Ok(DesktopOutcome::Text("Moved the pointer.".to_owned()))
        }
        DesktopCall::LeftDown => {
            maia_windows::left_button_down().map_err(failed)?;
            Ok(DesktopOutcome::Text("Pressed the left button.".to_owned()))
        }
        DesktopCall::LeftUp => {
            maia_windows::left_button_up().map_err(failed)?;
            Ok(DesktopOutcome::Text("Released the left button.".to_owned()))
        }
        DesktopCall::Cursor => {
            let (x, y) = maia_windows::cursor_position().map_err(failed)?;
            Ok(DesktopOutcome::Text(format!("[{x}, {y}]")))
        }
        DesktopCall::Scroll {
            direction,
            amount,
            at,
            modifiers,
        } => {
            maia_windows::scroll_wheel(direction, *amount, *at, modifiers).map_err(failed)?;
            Ok(DesktopOutcome::Text("Scrolled.".to_owned()))
        }
        DesktopCall::Type { text } => {
            maia_windows::type_text(text).map_err(failed)?;
            Ok(DesktopOutcome::Text("Typed.".to_owned()))
        }
        DesktopCall::Key { text, repeat } => {
            maia_windows::press_key(text, *repeat).map_err(failed)?;
            Ok(DesktopOutcome::Text("Pressed the key.".to_owned()))
        }
        DesktopCall::Hold { text, duration } => {
            maia_windows::hold_key(text, *duration).map_err(failed)?;
            Ok(DesktopOutcome::Text("Held the key.".to_owned()))
        }
        DesktopCall::Wait { duration } => {
            maia_windows::wait_seconds(*duration).map_err(failed)?;
            Ok(DesktopOutcome::Text("Waited.".to_owned()))
        }
    }
}

fn click(button: &'static str, count: u32, value: &Value) -> Result<DesktopCall, String> {
    Ok(DesktopCall::Click {
        button,
        count,
        at: optional_pair(value, "coordinate")?,
        modifiers: optional_string(value, "text")?.unwrap_or_default(),
    })
}

fn duration(value: &Value) -> Result<f64, String> {
    let number = value
        .get("duration")
        .and_then(Value::as_f64)
        .ok_or_else(|| "duration is required.".to_owned())?;
    if !(0.0..=300.0).contains(&number) {
        return Err("duration must be from 0 to 300 seconds.".to_owned());
    }
    Ok(number)
}

fn required_string(value: &Value, name: &str) -> Result<String, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{name} is required."))
}

fn optional_string(value: &Value, name: &str) -> Result<Option<String>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        _ => Err(format!("{name} must be a string.")),
    }
}

fn optional_i32(value: &Value, name: &str) -> Result<Option<i32>, String> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| format!("{name} must be an integer.")),
        _ => Err(format!("{name} must be an integer.")),
    }
}

fn required_array(value: &Value, name: &str) -> Result<Vec<i32>, String> {
    let array = value
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{name} is required."))?;
    array
        .iter()
        .map(|item| {
            item.as_f64()
                .map(|number| number as i32)
                .ok_or_else(|| format!("{name} must be numbers."))
        })
        .collect()
}

fn optional_pair(value: &Value, name: &str) -> Result<Option<(i32, i32)>, String> {
    if value.get(name).is_none() {
        return Ok(None);
    }
    Ok(Some(pair2(required_array(value, name)?)?))
}

fn pair2(values: Vec<i32>) -> Result<(i32, i32), String> {
    let [x, y] = values
        .try_into()
        .map_err(|_| "coordinate must be [x, y].".to_owned())?;
    Ok((x, y))
}

fn pair4(values: Vec<i32>) -> Result<(i32, i32, i32, i32), String> {
    let [x0, y0, x1, y1] = values
        .try_into()
        .map_err(|_| "region must be [x0, y0, x1, y1].".to_owned())?;
    Ok((x0, y0, x1, y1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_accepts_a_window_and_zoom_requires_four_numbers() {
        let shot = parse_desktop_call("screenshot", "{\"window\":\"Notepad\"}").expect("shot");
        assert!(matches!(shot, DesktopCall::Screenshot { window: Some(_) }));
        let zoom = parse_desktop_call("zoom", "{\"region\":[1,2,3,4]}").expect("zoom");
        assert!(matches!(
            zoom,
            DesktopCall::Zoom {
                x0: 1,
                y0: 2,
                x1: 3,
                y1: 4
            }
        ));
        assert!(parse_desktop_call("zoom", "{}").is_err());
    }
}
