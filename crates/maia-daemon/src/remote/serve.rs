//! Tailscale HTTPS listener and the HTTP responses in front of it.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::ConnectInfo;
use axum::extract::Request;
use axum::extract::State;
use axum::extract::connect_info::Connected;
use axum::http::HeaderValue;
use axum::http::StatusCode;
use axum::http::header;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::serve::IncomingStream;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

use super::admit::HostNames;
use super::admit::ListenerClass;
use super::admit::SessionView;
use super::admit::TailnetGate;
use super::admit::TailnetPeer;
use super::admit::TailnetRequest;
use super::admit::canonical_ip;
use super::admit::cookie_value;
use super::admit::gate_tailnet;
use super::admit::is_tailscale_ip;
use super::hub::DeviceView;
use super::hub::EnableResult;
use super::hub::IssuedCode;
use super::hub::PhoneState;
use super::hub::PreparedTls;
use super::hub::RemoteHub;
use super::hub::SessionIssued;
use super::hub::UnpairActor;
use super::hub::unix_now;

/// Marks a loopback request so desktop-only routes can see where it arrived.
pub async fn mark_loopback(mut request: Request, next: Next) -> Response {
    request.extensions_mut().insert(ListenerClass::Loopback);
    next.run(request).await
}

/// WhoIs, host, session, and CSRF gate for the Tailscale listener only.
pub async fn tailnet_gate(State(hub): State<RemoteHub>, request: Request, next: Next) -> Response {
    let Some(peer) = request.extensions().get::<ConnectInfo<PeerAddr>>().copied() else {
        return error_response(403, "denied");
    };
    let ip = canonical_ip(peer.0.0.ip());
    if ip.is_loopback() || !is_tailscale_ip(ip) {
        return error_response(403, "denied");
    }
    let now = unix_now();
    let hub_lookup = hub.clone();
    let identity = match tokio::task::spawn_blocking(move || hub_lookup.lookup(ip, now)).await {
        Ok(Ok(identity)) => identity,
        _ => return error_response(403, "whois_unavailable"),
    };
    let Some(names) = hub.host_names() else {
        return error_response(403, "denied");
    };
    let host = header_str(request.headers(), header::HOST).unwrap_or_default();
    let origin = header_str(request.headers(), header::ORIGIN);
    let fetch_site = header_str(
        request.headers(),
        header::HeaderName::from_static("sec-fetch-site"),
    );
    let csrf = header_str(
        request.headers(),
        header::HeaderName::from_static("x-csrf-token"),
    );
    let token = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|header| cookie_value(header, RemoteHub::cookie_name()))
        .map(str::to_owned);
    let owned = token.as_deref().and_then(|value| hub.session(value));
    let session = owned.as_ref().map(|row| SessionView {
        user_id: row.user_id.as_str(),
        node_id: row.node_id.as_str(),
        csrf: row.csrf.as_str(),
        idle_deadline: row.idle_deadline,
        absolute_deadline: row.absolute_deadline,
    });
    let paired = matches!(hub.phone_state(&identity), PhoneState::Paired { .. });
    let decision = gate_tailnet(
        &TailnetRequest {
            method: request.method().as_str(),
            path: request.uri().path(),
            host: &host,
            origin,
            fetch_site,
            csrf,
        },
        &identity,
        paired,
        session,
        &HostNames {
            dns_name: &names.dns_name,
            port: names.port,
            ips: &names.ips,
        },
        now,
    );
    if let TailnetGate::Reject { status, error } = decision {
        return error_response(status, error);
    }
    if let Some(value) = token.as_deref() {
        hub.touch(value, now);
    }
    let mut request = request;
    request.extensions_mut().insert(ListenerClass::Tailnet);
    request.extensions_mut().insert(TailnetPeer(identity));
    let mut response = next.run(request).await;
    insert_static(&mut response, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    insert_static(&mut response, header::REFERRER_POLICY, "no-referrer");
    response
}

/// Bind Tailscale when phone access is on, and wait for that switch when it is off.
pub async fn supervise(
    mut enable_rx: mpsc::Receiver<()>,
    hub: RemoteHub,
    app: Router,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        if *stop.borrow() {
            return;
        }
        if !hub.is_enabled() {
            tokio::select! {
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        return;
                    }
                }
                message = enable_rx.recv() => {
                    if message.is_none() {
                        return;
                    }
                }
            }
            continue;
        }
        let prepared = {
            let hub = hub.clone();
            match tokio::task::spawn_blocking(move || hub.prepare()).await {
                Ok(Ok(prepared)) => prepared,
                Ok(Err(())) => {
                    if pause(&mut stop).await {
                        return;
                    }
                    continue;
                }
                Err(_) => return,
            }
        };
        let listeners = bind_listeners(&prepared, hub.port()).await;
        if listeners.is_empty() {
            hub.set_unavailable("The Tailscale address could not be opened.");
            if pause(&mut stop).await {
                return;
            }
            continue;
        }
        hub.set_ready(&prepared.dns_name, &prepared.ips);
        let mut tasks = Vec::new();
        for listener in listeners {
            let app = app.clone();
            let mut task_stop = stop.clone();
            tasks.push(tokio::spawn(async move {
                let _ = axum::serve(
                    listener,
                    app.into_make_service_with_connect_info::<PeerAddr>(),
                )
                .with_graceful_shutdown(async move {
                    loop {
                        if *task_stop.borrow() {
                            break;
                        }
                        if task_stop.changed().await.is_err() {
                            break;
                        }
                    }
                })
                .await;
            }));
        }
        loop {
            if *stop.borrow() {
                break;
            }
            if stop.changed().await.is_err() {
                break;
            }
        }
        for task in tasks {
            let _ = task.await;
        }
        return;
    }
}

/// Desktop status, including the URL once the listener is up.
pub fn desktop_status_response(hub: &RemoteHub, now: i64) -> Response {
    let status = hub.desktop_status(now);
    Json(serde_json::json!({
        "enabled": status.enabled,
        "phase": status.phase,
        "url": status.url,
        "reason": status.reason,
        "code_active": status.code_active,
        "devices": device_json(&status.devices),
    }))
    .into_response()
}

/// Phone status. An unpaired node does not see other devices.
pub fn phone_status_response(
    hub: &RemoteHub,
    identity: &super::admit::TailnetIdentity,
) -> Response {
    match hub.phone_state(identity) {
        PhoneState::Unpaired { node_name } => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unpaired", "node_name": node_name })),
        )
            .into_response(),
        PhoneState::Denied => error_response(403, "denied"),
        PhoneState::Paired { url, devices } => Json(serde_json::json!({
            "phase": "ready",
            "url": url,
            "devices": device_json(&devices),
        }))
        .into_response(),
    }
}

/// Enable phone access after the desktop acknowledges certificate publication.
pub fn enable_response(hub: &RemoteHub, acknowledged: bool) -> Response {
    match hub.enable(acknowledged) {
        EnableResult::Started => desktop_status_response(hub, unix_now()),
        EnableResult::NeedsAcknowledgement => error_response(400, "acknowledgement_required"),
        EnableResult::Unavailable => error_response(503, "unavailable"),
    }
}

/// Show a pairing code once.
pub fn code_response(hub: &RemoteHub, now: i64) -> Response {
    match hub.issue_code(now) {
        IssuedCode::Shown { code, expires_at } => {
            Json(serde_json::json!({ "code": code, "expires_at": expires_at })).into_response()
        }
        IssuedCode::NotEnabled => error_response(409, "not_enabled"),
        IssuedCode::Unavailable => error_response(503, "unavailable"),
    }
}

/// Accept a pairing code from the phone that WhoIs just identified.
pub fn pair_response(
    hub: &RemoteHub,
    identity: &super::admit::TailnetIdentity,
    code: &str,
    now: i64,
) -> Response {
    session_body(hub.accept_pair(identity, code, now))
}

/// Issue a session for a phone that is already paired.
pub fn session_response(
    hub: &RemoteHub,
    identity: &super::admit::TailnetIdentity,
    now: i64,
) -> Response {
    session_body(hub.establish(identity, now))
}

/// Remove one paired node.
pub fn unpair_response(hub: &RemoteHub, actor: UnpairActor, node_id: &str, now: i64) -> Response {
    if hub.unpair(actor, node_id) {
        return desktop_status_response(hub, now);
    }
    error_response(404, "unknown_device")
}

/// JSON error with a stable `error` token.
pub fn error_response(status: u16, error: &'static str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::FORBIDDEN);
    (code, Json(serde_json::json!({ "error": error }))).into_response()
}

fn session_body(issued: SessionIssued) -> Response {
    match issued {
        SessionIssued::Connected {
            token,
            csrf,
            max_age,
        } => {
            let mut response =
                Json(serde_json::json!({ "csrf": csrf, "state": "paired" })).into_response();
            if let Ok(value) = HeaderValue::from_str(&RemoteHub::cookie_header(&token, max_age)) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        SessionIssued::Unpaired => error_response(401, "unpaired"),
        SessionIssued::InvalidCode => error_response(401, "invalid_code"),
        SessionIssued::Locked => error_response(429, "too_many_attempts"),
        SessionIssued::Denied => error_response(403, "denied"),
    }
}

fn device_json(devices: &[DeviceView]) -> Vec<serde_json::Value> {
    devices
        .iter()
        .map(|device| {
            serde_json::json!({
                "node_id": device.node_id,
                "name": device.name,
                "paired_at": device.paired_at,
            })
        })
        .collect()
}

fn header_str(headers: &axum::http::HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn insert_static(response: &mut Response, name: header::HeaderName, value: &'static str) {
    if let Ok(header_value) = HeaderValue::from_str(value) {
        response.headers_mut().insert(name, header_value);
    }
}

async fn bind_listeners(prepared: &PreparedTls, port: u16) -> Vec<TlsListener> {
    let acceptor = TlsAcceptor::from(prepared.config.clone());
    let mut listeners = Vec::new();
    for ip in &prepared.ips {
        if !is_tailscale_ip(*ip) {
            continue;
        }
        let Ok(listener) = TcpListener::bind(SocketAddr::new(*ip, port)).await else {
            continue;
        };
        listeners.push(TlsListener {
            listener,
            acceptor: acceptor.clone(),
        });
    }
    listeners
}

async fn pause(stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(15)) => false,
        changed = stop.changed() => changed.is_err() || *stop.borrow(),
    }
}

#[derive(Clone, Copy)]
struct PeerAddr(SocketAddr);

impl Connected<IncomingStream<'_, TlsListener>> for PeerAddr {
    fn connect_info(stream: IncomingStream<'_, TlsListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

struct TlsListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = match self.listener.accept().await {
                Ok(pair) => pair,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            match self.acceptor.accept(stream).await {
                Ok(tls) => return (tls, addr),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}
