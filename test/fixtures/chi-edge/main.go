package main

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Product struct {
	SKU   string   `json:"sku"`
	Price float64  `json:"price"`
	Tags  []string `json:"tags"`
}

type ProductInput struct {
	SKU   string `json:"sku"`
	Price float64 `json:"price"`
}

type ErrorBody struct {
	Error string `json:"error"`
}

func listProducts(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	tag := query.Get("tag")
	trace := r.Header.Get("X-Trace")
	session, _ := r.Cookie("session")
	_ = tag
	_ = trace
	_ = session
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode([]Product{{SKU: "a", Price: 1.5}})
}

func createProduct(w http.ResponseWriter, r *http.Request) {
	var input ProductInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(ErrorBody{Error: "bad body"})
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(Product{SKU: input.SKU, Price: input.Price})
}

func getProduct(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "0" {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(ErrorBody{Error: "missing"})
		return
	}
	_ = id
	_ = json.NewEncoder(w).Encode(Product{SKU: "a", Price: 1.5})
}

func streamProducts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("event: tick\ndata: {}\n\n"))
}

func health(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func adminRouter() http.Handler {
	r := chi.NewRouter()
	r.Delete("/products/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return r
}

func main() {
	r := chi.NewRouter()
	r.Route("/v1", func(r chi.Router) {
		r.Get("/products", listProducts)
		r.Post("/products", createProduct)
		r.Group(func(r chi.Router) {
			r.Get("/products/{id}", getProduct)
			r.Get("/products/events", streamProducts)
		})
		r.Get("/health", health)
		r.Mount("/admin", adminRouter())
	})
	http.ListenAndServe(":8092", r)
}
