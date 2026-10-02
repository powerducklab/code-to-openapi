use actix_web::{web, App, HttpResponse, Responder};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct User {
    id: i32,
    name: String,
    note: Option<String>,
}

#[derive(Deserialize)]
struct UserInput {
    name: String,
}

#[derive(Deserialize)]
struct UserQuery {
    q: Option<String>,
    limit: Option<u32>,
}

#[derive(Serialize)]
struct ErrorBody {
    message: String,
}

// Macro-annotated handler: path param + Json response.
#[get("/users/{id}")]
async fn get_user(path: web::Path<i32>) -> HttpResponse {
    let id = path.into_inner();
    HttpResponse::Ok().json(User {
        id,
        name: "ada".to_string(),
        note: None,
    })
}

// Query extractor + Json list response.
#[get("/users")]
async fn list_users(query: web::Query<UserQuery>) -> impl Responder {
    let _ = query;
    HttpResponse::Ok().json(vec![User {
        id: 1,
        name: "ada".to_string(),
        note: None,
    }])
}

// Json request body -> 201 Created.
#[post("/users")]
async fn create_user(body: web::Json<UserInput>) -> HttpResponse {
    HttpResponse::Created().json(User {
        id: 2,
        name: body.name.clone(),
        note: None,
    })
}

// Non-200: BadRequest with a JSON error body.
#[get("/users/{id}/fail")]
async fn fail_user(path: web::Path<i32>) -> HttpResponse {
    let _ = path;
    HttpResponse::BadRequest().json(ErrorBody {
        message: "bad".to_string(),
    })
}

// NoContent response.
#[delete("/users/{id}")]
async fn delete_user(path: web::Path<i32>) -> HttpResponse {
    let _ = path;
    HttpResponse::NoContent().finish()
}

// Streaming response (binary octet-stream).
#[get("/report")]
async fn report() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/octet-stream")
        .streaming(std::io::empty())
}

// Handler mounted inside a scope via .service() — path comes from the macro,
// the /api prefix is added by the scope registration in main().
#[get("/health")]
async fn health() -> &'static str {
    "ok"
}

// Inline regex guard segment: the `:regex` must be stripped for OAS.
#[get("/page-{id:\\d+}")]
async fn page_by_regex(path: web::Path<i32>) -> HttpResponse {
    let id = path.into_inner();
    HttpResponse::Ok().json(User { id, name: "page".to_string(), note: None })
}

// Tail segment `{name}*`: the trailing `*` must be stripped for OAS.
#[get("/files/{tail}*")]
async fn files_tail(path: web::Path<(String,)>) -> HttpResponse {
    let _ = path;
    HttpResponse::Ok().finish()
}

fn config_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/articles").route(web::get().to(list_articles)));
}

async fn list_articles() -> impl Responder {
    HttpResponse::Ok().json(vec![1, 2, 3])
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let app = App::new()
        .service(web::scope("/api").service(get_user).service(list_users).service(create_user).service(fail_user).service(delete_user).service(report).service(health).service(page_by_regex).service(files_tail))
        .configure(config_routes);
    actix_web::HttpServer::new(move || app.clone())
        .bind(("127.0.0.1", 8096))?
        .run()
        .await
}
