use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
pub struct User {
    pub username: String,
}

// Scoped Result return, as in `crate::http::Result<Json<T>>`.
async fn get_user() -> std::result::Result<Json<User>, ()> {
    unimplemented!()
}

// Each module defines its own `router()`; the function-name map must retain all
// of them so `.merge(crate::articles::router())` resolves the right one.
pub fn router() -> Router {
    Router::new().route("/api/user", get(get_user))
}

fn app() -> Router {
    router().merge(crate::articles::router())
}

fn main() {
    let _ = app();
}
