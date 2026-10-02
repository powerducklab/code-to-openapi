package main

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/mux"
)

type Product struct {
	SKU   string  `json:"sku"`
	Price float64 `json:"price"`
}

type ProductInput struct {
	SKU   string `json:"sku"`
	Price float64 `json:"price"`
}

type ErrBody struct {
	Error string `json:"error"`
}

func listProducts(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	_ = vars
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]Product{{SKU: "a", Price: 1.5}})
}

func getProduct(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	if id == "0" {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(ErrBody{Error: "missing"})
		return
	}
	_ = id
	_ = json.NewEncoder(w).Encode(Product{SKU: id, Price: 2.0})
}

func createProduct(w http.ResponseWriter, r *http.Request) {
	var in ProductInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(Product{SKU: in.SKU, Price: in.Price})
}

func main() {
	r := mux.NewRouter()

	r.HandleFunc("/products", listProducts).
		Methods("GET").
		Queries("tag", "{tag}").
		Headers("X-Trace", ".*")

	r.HandleFunc("/products/{id:[0-9]+}", getProduct).Methods("GET")
	r.HandleFunc("/products", createProduct).Methods("POST")

	// Subrouter mounted at /api (gorilla matches the full path).
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pong"))
	}).Methods("GET")

	http.ListenAndServe(":8094", r)
}
