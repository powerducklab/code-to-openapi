package main

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Article struct {
	Slug string `json:"slug"`
}

func listArticles(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode([]Article{{Slug: "a"}})
}

func getArticle(w http.ResponseWriter, r *http.Request) {
	_ = json.NewEncoder(w).Encode(Article{Slug: "x"})
}

// setupRoutes is called from main with the router; routes registered here must
// still be discovered.
func setupRoutes(r chi.Router) {
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func paginate(next http.Handler) http.Handler { return next }

func main() {
	r := chi.NewRouter()

	r.Route("/articles", func(r chi.Router) {
		r.With(paginate).Get("/", listArticles)
		r.Get("/{slug:[a-z-]+}", getArticle)
	})

	setupRoutes(r)

	http.ListenAndServe(":8095", r)
}
