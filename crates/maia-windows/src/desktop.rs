//! Interactive desktop capture and input for computer use.

use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::LPARAM;
use windows::Win32::Foundation::POINT;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::BI_RGB;
use windows::Win32::Graphics::Gdi::BITMAPINFO;
use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;
use windows::Win32::Graphics::Gdi::BitBlt;
use windows::Win32::Graphics::Gdi::CreateCompatibleBitmap;
use windows::Win32::Graphics::Gdi::CreateCompatibleDC;
use windows::Win32::Graphics::Gdi::DIB_RGB_COLORS;
use windows::Win32::Graphics::Gdi::DeleteDC;
use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::Graphics::Gdi::GetDC;
use windows::Win32::Graphics::Gdi::GetDIBits;
use windows::Win32::Graphics::Gdi::ReleaseDC;
use windows::Win32::Graphics::Gdi::SRCCOPY;
use windows::Win32::Graphics::Gdi::SelectObject;
use windows::Win32::System::Threading::OpenProcess;
use windows::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows::Win32::System::Threading::QueryFullProcessImageNameW;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT_KEYBOARD;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT_MOUSE;
use windows::Win32::UI::Input::KeyboardAndMouse::KEYBDINPUT;
use windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_KEYUP;
use windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_UNICODE;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_ABSOLUTE;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_LEFTDOWN;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_LEFTUP;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MIDDLEDOWN;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MIDDLEUP;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_MOVE;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_RIGHTDOWN;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_RIGHTUP;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_WHEEL;
use windows::Win32::UI::Input::KeyboardAndMouse::MOUSEINPUT;
use windows::Win32::UI::Input::KeyboardAndMouse::SendInput;
use windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_BACK;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_CONTROL;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_DELETE;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_DOWN;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_END;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_HOME;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_LEFT;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_LWIN;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_NEXT;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_PRIOR;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_RETURN;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_RIGHT;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_SHIFT;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_TAB;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_UP;
use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
use windows::Win32::UI::WindowsAndMessaging::GetSystemMetrics;
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows::Win32::UI::WindowsAndMessaging::GetWindowTextLengthW;
use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
use windows::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN;
use windows::Win32::UI::WindowsAndMessaging::SM_CYVIRTUALSCREEN;
use windows::Win32::UI::WindowsAndMessaging::SM_XVIRTUALSCREEN;
use windows::Win32::UI::WindowsAndMessaging::SM_YVIRTUALSCREEN;
use windows::core::BOOL;
use windows::core::PWSTR;

/// Why a desktop action failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopError {
    /// The display could not be captured.
    Capture,
    /// No visible window matched the query.
    Window,
    /// The pointer or keyboard input was not delivered.
    Input,
    /// The region was empty or inverted.
    Bounds,
}

impl std::fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::Capture => "The display could not be captured.",
            Self::Window => "No visible window matched that app.",
            Self::Input => "The desktop input was not delivered.",
            Self::Bounds => "That region is empty.",
        };
        formatter.write_str(text)
    }
}

impl std::error::Error for DesktopError {}

/// Captures the whole display, or one window when `window` is set.
pub fn capture_display(window: Option<&str>) -> Result<Vec<u8>, DesktopError> {
    match window.map(str::trim).filter(|text| !text.is_empty()) {
        Some(query) => {
            let hwnd = find_window(query).ok_or(DesktopError::Window)?;
            capture_hwnd(hwnd)
        }
        None => {
            let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
            let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
            let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
            let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
            capture_screen_rect(origin_x, origin_y, width, height)
        }
    }
}

/// Captures one pixel region of the display.
pub fn capture_region(x0: i32, y0: i32, x1: i32, y1: i32) -> Result<Vec<u8>, DesktopError> {
    let left = x0.min(x1);
    let top = y0.min(y1);
    let width = (x0 - x1).abs();
    let height = (y0 - y1).abs();
    if width == 0 || height == 0 {
        return Err(DesktopError::Bounds);
    }
    capture_screen_rect(left, top, width, height)
}

/// Clicks a mouse button. `at` omitted uses the current pointer.
pub fn pointer_click(
    button: &str,
    count: u32,
    at: Option<(i32, i32)>,
    modifiers: &str,
) -> Result<(), DesktopError> {
    if let Some((x, y)) = at {
        pointer_move((x, y))?;
    }
    let mods = chord_keys(modifiers)?;
    key_states(&mods, false)?;
    for _ in 0..count.max(1) {
        mouse_button(button, true)?;
        mouse_button(button, false)?;
    }
    key_states(&mods, true)?;
    Ok(())
}

/// Drags from `start` to `end`.
pub fn pointer_drag(
    start: (i32, i32),
    end: (i32, i32),
    modifiers: &str,
) -> Result<(), DesktopError> {
    let mods = chord_keys(modifiers)?;
    key_states(&mods, false)?;
    pointer_move(start)?;
    mouse_button("left", true)?;
    pointer_move(end)?;
    mouse_button("left", false)?;
    key_states(&mods, true)?;
    Ok(())
}

/// Moves the pointer to a screen point.
pub fn pointer_move(at: (i32, i32)) -> Result<(), DesktopError> {
    let (dx, dy) = absolute_point(at.0, at.1);
    send_mouse(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE)
}

/// Presses the left button.
pub fn left_button_down() -> Result<(), DesktopError> {
    send_mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)
}

/// Releases the left button.
pub fn left_button_up() -> Result<(), DesktopError> {
    send_mouse(0, 0, 0, MOUSEEVENTF_LEFTUP)
}

/// Returns the current pointer position.
pub fn cursor_position() -> Result<(i32, i32), DesktopError> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.map_err(|_| DesktopError::Input)?;
    Ok((point.x, point.y))
}

/// Scrolls the wheel. `amount` is the number of wheel clicks.
pub fn scroll_wheel(
    direction: &str,
    amount: i32,
    at: Option<(i32, i32)>,
    modifiers: &str,
) -> Result<(), DesktopError> {
    if let Some(point) = at {
        pointer_move(point)?;
    }
    let delta = amount.max(1) * 120;
    let data = match direction {
        "up" => delta,
        "down" => -delta,
        "left" => -delta,
        "right" => delta,
        _ => return Err(DesktopError::Input),
    };
    let flags = if matches!(direction, "left" | "right") {
        windows::Win32::UI::Input::KeyboardAndMouse::MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    let mods = chord_keys(modifiers)?;
    key_states(&mods, false)?;
    send_mouse(0, 0, data, flags)?;
    key_states(&mods, true)?;
    Ok(())
}

/// Types Unicode text.
pub fn type_text(text: &str) -> Result<(), DesktopError> {
    for character in text.chars() {
        if character == '\n' || character == '\r' {
            press_virtual(VK_RETURN, 1)?;
            continue;
        }
        send_unicode(character, false)?;
        send_unicode(character, true)?;
    }
    Ok(())
}

/// Presses a key chord `repeat` times.
pub fn press_key(chord: &str, repeat: u32) -> Result<(), DesktopError> {
    let (modifiers, key) = split_chord(chord)?;
    for _ in 0..repeat.max(1) {
        key_states(&modifiers, false)?;
        press_virtual(key, 1)?;
        key_states(&modifiers, true)?;
    }
    Ok(())
}

/// Holds a chord for `seconds`.
pub fn hold_key(chord: &str, seconds: f64) -> Result<(), DesktopError> {
    let (modifiers, key) = split_chord(chord)?;
    key_states(&modifiers, false)?;
    key_down(key)?;
    thread::sleep(Duration::from_secs_f64(seconds.clamp(0.0, 300.0)));
    key_up(key)?;
    key_states(&modifiers, true)?;
    Ok(())
}

/// Pauses for `seconds`.
pub fn wait_seconds(seconds: f64) -> Result<(), DesktopError> {
    thread::sleep(Duration::from_secs_f64(seconds.clamp(0.0, 300.0)));
    Ok(())
}

fn capture_screen_rect(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, DesktopError> {
    if width <= 0 || height <= 0 {
        return Err(DesktopError::Bounds);
    }
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(DesktopError::Capture);
        }
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, width, height, Some(screen), x, y, SRCCOPY);
        SelectObject(memory, previous);
        let png = if copied.is_ok() {
            bitmap_png(memory, bitmap, width, height)
        } else {
            Err(DesktopError::Capture)
        };
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);
        png
    }
}

fn capture_hwnd(hwnd: HWND) -> Result<Vec<u8>, DesktopError> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|_| DesktopError::Window)?;
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err(DesktopError::Bounds);
    }
    capture_screen_rect(rect.left, rect.top, width, height)
}

unsafe fn bitmap_png(
    memory: windows::Win32::Graphics::Gdi::HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
) -> Result<Vec<u8>, DesktopError> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
    };
    let stride = usize::try_from(width).unwrap_or(0).saturating_mul(4);
    let mut bgra = vec![0u8; stride.saturating_mul(usize::try_from(height).unwrap_or(0))];
    let rows = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            u32::try_from(height).unwrap_or(0),
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if rows == 0 {
        return Err(DesktopError::Capture);
    }
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
    }
    let _ = memory;
    encode_png(u32::try_from(width).unwrap_or(0), u32::try_from(height).unwrap_or(0), &rgba)
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, DesktopError> {
    let mut buffer = Vec::new();
    let mut encoder = png::Encoder::new(&mut buffer, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|_| DesktopError::Capture)?;
    writer
        .write_image_data(rgba)
        .map_err(|_| DesktopError::Capture)?;
    drop(writer);
    Ok(buffer)
}

struct WindowSearch {
    query: String,
    found: Option<HWND>,
}

fn find_window(query: &str) -> Option<HWND> {
    let mut search = WindowSearch {
        query: query.to_lowercase(),
        found: None,
    };
    let param = LPARAM(&mut search as *mut WindowSearch as isize);
    unsafe { EnumWindows(Some(on_window), param) }.ok()?;
    search.found
}

unsafe extern "system" fn on_window(hwnd: HWND, param: LPARAM) -> BOOL {
    let search = unsafe { &mut *(param.0 as *mut WindowSearch) };
    if unsafe { !IsWindowVisible(hwnd).as_bool() } {
        return BOOL(1);
    }
    let title = unsafe { window_title(hwnd) }.to_lowercase();
    let process = unsafe { process_name(hwnd) }.to_lowercase();
    if title.contains(&search.query) || process.contains(&search.query) {
        search.found = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

unsafe fn window_title(hwnd: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return String::new();
    }
    let mut buffer = vec![0u16; usize::try_from(length).unwrap_or(0).saturating_add(1)];
    let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if copied <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..usize::try_from(copied).unwrap_or(0)])
}

unsafe fn process_name(hwnd: HWND) -> String {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return String::new();
    };
    let mut buffer = [0u16; 512];
    let mut length = buffer.len() as u32;
    let name = unsafe {
        QueryFullProcessImageNameW(
            process,
            windows::Win32::System::Threading::PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };
    if name.is_err() {
        return String::new();
    }
    let text = String::from_utf16_lossy(&buffer[..usize::try_from(length).unwrap_or(0)]);
    text.rsplit(['\\', '/']).next().unwrap_or("").to_owned()
}

fn absolute_point(x: i32, y: i32) -> (i32, i32) {
    let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
    let dx = (x - origin_x).saturating_mul(65535) / (width - 1).max(1);
    let dy = (y - origin_y).saturating_mul(65535) / (height - 1).max(1);
    (dx, dy)
}

fn mouse_button(button: &str, down: bool) -> Result<(), DesktopError> {
    let flag = match (button, down) {
        ("left", true) => MOUSEEVENTF_LEFTDOWN,
        ("left", false) => MOUSEEVENTF_LEFTUP,
        ("right", true) => MOUSEEVENTF_RIGHTDOWN,
        ("right", false) => MOUSEEVENTF_RIGHTUP,
        ("middle", true) => MOUSEEVENTF_MIDDLEDOWN,
        ("middle", false) => MOUSEEVENTF_MIDDLEUP,
        _ => return Err(DesktopError::Input),
    };
    send_mouse(0, 0, 0, flag)
}

fn send_mouse(
    dx: i32,
    dy: i32,
    data: i32,
    flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS,
) -> Result<(), DesktopError> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0)) };
    if sent == 1 { Ok(()) } else { Err(DesktopError::Input) }
}

fn send_unicode(character: char, up: bool) -> Result<(), DesktopError> {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: u16::try_from(u32::from(character)).unwrap_or(0),
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0)) };
    if sent == 1 { Ok(()) } else { Err(DesktopError::Input) }
}

fn press_virtual(key: VIRTUAL_KEY, repeat: u32) -> Result<(), DesktopError> {
    for _ in 0..repeat {
        key_down(key)?;
        key_up(key)?;
    }
    Ok(())
}

fn key_down(key: VIRTUAL_KEY) -> Result<(), DesktopError> {
    send_key(key, false)
}

fn key_up(key: VIRTUAL_KEY) -> Result<(), DesktopError> {
    send_key(key, true)
}

fn send_key(key: VIRTUAL_KEY, up: bool) -> Result<(), DesktopError> {
    let flags = if up { KEYEVENTF_KEYUP } else { windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(0) };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let sent = unsafe { SendInput(&[input], i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(0)) };
    if sent == 1 { Ok(()) } else { Err(DesktopError::Input) }
}

fn key_states(keys: &[VIRTUAL_KEY], up: bool) -> Result<(), DesktopError> {
    let order = if up {
        keys.iter().rev().copied().collect::<Vec<_>>()
    } else {
        keys.to_vec()
    };
    for key in order {
        send_key(key, up)?;
    }
    Ok(())
}

fn chord_keys(modifiers: &str) -> Result<Vec<VIRTUAL_KEY>, DesktopError> {
    if modifiers.trim().is_empty() {
        return Ok(Vec::new());
    }
    modifiers
        .split('+')
        .filter(|part| !part.trim().is_empty())
        .map(named_key)
        .collect()
}

fn split_chord(chord: &str) -> Result<(Vec<VIRTUAL_KEY>, VIRTUAL_KEY), DesktopError> {
    let mut parts = chord
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let Some(last) = parts.pop() else {
        return Err(DesktopError::Input);
    };
    let key = named_key(last)?;
    let modifiers = parts.into_iter().map(named_key).collect::<Result<Vec<_>, _>>()?;
    Ok((modifiers, key))
}

fn named_key(name: &str) -> Result<VIRTUAL_KEY, DesktopError> {
    let key = match name.to_ascii_lowercase().as_str() {
        "return" | "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "space" => VK_SPACE,
        "up" => VK_UP,
        "down" => VK_DOWN,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" | "prior" => VK_PRIOR,
        "pagedown" | "next" => VK_NEXT,
        "shift" => VK_SHIFT,
        "ctrl" | "control" => VK_CONTROL,
        "alt" => VK_MENU,
        "super" | "win" | "meta" => VK_LWIN,
        other if other.chars().count() == 1 => {
            let character = other.chars().next().unwrap_or(' ');
            if character.is_ascii_alphanumeric() {
                VIRTUAL_KEY(character.to_ascii_uppercase() as u16)
            } else {
                return Err(DesktopError::Input);
            }
        }
        _ => return Err(DesktopError::Input),
    };
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::capture_display;

    #[test]
    fn capture_display_returns_a_png() {
        let bytes = capture_display(None).expect("capture");
        assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));
    }
}
