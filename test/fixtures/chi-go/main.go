package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
)

type User struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

func main() {
	r := chi.NewRouter()
	r.Get("/health", health)
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/users", listUsers)
		r.Post("/users", createUser)
		r.Get("/users/{userID}", getUser)
		r.Mount("/admin", adminRouter())
	})
	http.ListenAndServe(":8090", r)
}

func adminRouter() http.Handler {
	rr := chi.NewRouter()
	rr.Delete("/users/{id}", deleteUser)
	return rr
}

func health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func listUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	_ = q
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]User{})
}

func createUser(w http.ResponseWriter, r *http.Request) {
	var input User
	_ = json.NewDecoder(r.Body).Decode(&input)
	w.WriteHeader(http.StatusCreated)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(input)
}

func getUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "userID")
	if id == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(&User{})
}

func deleteUser(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}
