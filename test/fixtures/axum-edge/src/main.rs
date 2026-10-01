use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        Redirect,
    },
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio::stream;

#[derive(Serialize)]
struct Order {
    id: String,
    amount: f64,
    note: Option<String>,
}

#[derive(Deserialize)]
struct OrderInput {
    amount: f64,
    note: Option<String>,
}

#[derive(Deserialize)]
struct OrderFilter {
    q: Option<String>,
    limit: Option<u32>,
}

#[derive(Serialize)]
struct OrderEvent {
    order_id: String,
    stage: String,
}

#[derive(Clone)]
struct AppState {
    region: String,
}

async fn health() -> &'static str {
    "ok"
}

async fn list_orders(
    State(_state): State<AppState>,
    Query(filter): Query<OrderFilter>,
) -> Json<Vec<Order>> {
    let _ = filter;
    Json(vec![])
}

async fn create_order(Json(input): Json<OrderInput>) -> (StatusCode, Json<Order>) {
    (
        StatusCode::CREATED,
        Json(Order {
            id: "o1".to_string(),
            amount: input.amount,
            note: input.note,
        }),
    )
}

async fn get_order(Path(id): Path<String>) -> Json<Order> {
    Json(Order {
        id,
        amount: 1.0,
        note: None,
    })
}

async fn cancel_order(Path((_tenant, id)): Path<(String, String)>) -> StatusCode {
    let _ = id;
    StatusCode::NO_CONTENT
}

async fn legacy_order(Path(id): Path<String>) -> Redirect {
    Redirect::to(&format!("/api/orders/{id}"))
}

async fn order_events(Path(id): Path<String>) -> Sse<impl stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = stream::once(async move {
        Ok(Event::default().json_data(OrderEvent {
            order_id: id,
            stage: "created".to_string(),
        }).unwrap())
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn admin_routes() -> Router {
    Router::new().route("/orders/{id}/replay", post(replay_order))
}

async fn replay_order(Path(id): Path<String>) -> (StatusCode, Json<Order>) {
    let _ = id;
    (StatusCode::ACCEPTED, Json(Order { id: "x".into(), amount: 0.0, note: None }))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/orders", get(list_orders).post(create_order))
        .route("/api/orders/{id}", get(get_order))
        .route("/api/tenants/{tenant}/orders/{id}/cancel", post(cancel_order))
        .route("/api/legacy/orders/{id}", get(legacy_order))
        .route("/api/orders/{id}/events", get(order_events))
        .nest("/admin", admin_routes())
        .with_state(AppState { region: "us".into() });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8095").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
