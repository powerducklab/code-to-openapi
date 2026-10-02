use rocket::{get, post, routes, serde::json::Json, State};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct User {
    id: usize,
    name: String,
}

#[derive(Deserialize)]
struct NewUser {
    name: String,
}

// Path params with a typed guard (<age:usize>).
#[get("/hello/<name>/<age:usize>")]
fn hello(name: &str, age: usize) -> String {
    format!("{} {}", name, age)
}

// Json body via `data = "<body>"`, Json<T> response.
#[post("/users", data = "<body>")]
fn create_user(body: Json<NewUser>) -> Json<User> {
    Json(User {
        id: 1,
        name: body.name.clone(),
    })
}

// Request guard (BasicAuth) is not a route/query/body parameter.
#[get("/protected")]
fn protected(_auth: BasicAuth) -> &'static str {
    "ok"
}

// Status responder: status::Accepted<T>.
#[get("/accepted")]
fn accepted() -> rocket::response::status::Accepted<&'static str> {
    rocket::response::status::Accepted(Some("queued"))
}

// Plain path param returning Json list.
#[get("/users/<id>")]
fn get_user(id: usize) -> Json<User> {
    Json(User { id, name: "ada".into() })
}

struct BasicAuth;

#[rocket::launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", routes![hello, get_user, protected, accepted])
        .mount("/api", routes![create_user])
}
