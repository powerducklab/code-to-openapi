use axum::{
    extract::{Path, Query},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize, Deserialize)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub price: f64,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
}

#[derive(Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub code: i32,
    pub message: String,
    pub data: T,
}

#[derive(Serialize, Deserialize)]
pub struct PageResult<T> {
    pub items: Vec<T>,
    pub page: i32,
    pub per_page: i32,
    pub total: i64,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub page: i32,
    pub keyword: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateProductBody {
    pub name: String,
    pub price: f64,
}

async fn get_product(Path(id): Path<String>) -> Json<ApiResponse<Product>> {
    let _ = id;
    unimplemented!()
}

async fn list_products(
    Query(query): Query<ListQuery>,
) -> Json<ApiResponse<PageResult<Product>>> {
    let _ = query;
    unimplemented!()
}

async fn create_product(
    Json(payload): Json<CreateProductBody>,
) -> (StatusCode, Json<ApiResponse<Product>>) {
    let _ = payload;
    (StatusCode::CREATED, Json(unimplemented!()))
}

pub fn router() -> Router {
    Router::new()
        .route("/api/products/{id}", get(get_product))
        .route("/api/products", get(list_products).post(create_product))
}
