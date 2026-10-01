use axum::{
    extract::{Path, Query},
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router, StatusCode,
};
use serde::Deserialize;
use std::convert::Infallible;
use std::net::SocketAddr;
use tokio_stream::StreamExt;

#[derive(Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
    pub tags: Vec<String>,
}

#[derive(Deserialize)]
pub struct CreateUser {
    pub name: String,
    pub age: Option<i32>,
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: String,
    pub page: Option<i64>,
}

#[derive(Deserialize)]
pub struct ArchivePath {
    pub user_id: String,
}

async fn list_users() -> Json<Vec<User>> {
    Json(Vec::new())
}

async fn get_user(Path(id): Path<String>) -> Json<User> {
    unimplemented!()
}

async fn create_user(Json(payload): Json<CreateUser>) -> (StatusCode, Json<User>) {
    (StatusCode::CREATED, unimplemented!())
}

async fn search(Query(params): Query<SearchParams>) -> Json<Vec<User>> {
    Json(Vec::new())
}

async fn remove_user(Path(id): Path<String>) -> StatusCode {
    let _ = id;
    StatusCode::NO_CONTENT
}

async fn archive_user(Path(path): Path<ArchivePath>) -> StatusCode {
    let _ = path.user_id;
    StatusCode::NO_CONTENT
}

async fn health() -> &'static str {
    "ok"
}

async fn events() -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let stream = futures::stream::iter(vec![Ok::<_, Infallible>(Event::default())]);
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default())
}

fn api_router() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/users/{user_id}/archive", post(archive_user))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/users", get(list_users).post(create_user))
        .route("/users/search", get(search))
        .route("/users/{id}", get(get_user).delete(remove_user))
        .route("/events", get(events))
        .nest("/api", api_router());

    let addr: SocketAddr = "127.0.0.1:8080".parse().unwrap();
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
