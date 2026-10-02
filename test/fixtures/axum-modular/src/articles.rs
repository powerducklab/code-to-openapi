use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
pub struct Article {
    pub slug: String,
}

async fn get_article() -> Json<Article> {
    unimplemented!()
}

async fn list_comments() -> Json<Vec<String>> {
    unimplemented!()
}

pub fn router() -> Router {
    Router::new()
        .route("/api/articles/:slug", get(get_article))
        .merge(comment_routes())
}

// A nested builder referenced by merge; its routes must still surface.
fn comment_routes() -> Router {
    Router::new().route("/api/articles/:slug/comments", get(list_comments))
}
