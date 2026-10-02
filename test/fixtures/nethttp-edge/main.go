package main

import (
	"encoding/json"
	"net/http"
)

type Item struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Price float64 `json:"price"`
}

type ItemInput struct {
	Name  string  `json:"name"`
	Price float64 `json:"price"`
}

type ErrBody struct {
	Error string `json:"error"`
}

func listItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	tag := q.Get("tag")
	trace := r.Header.Get("X-Trace")
	_, _ = r.Cookie("session")
	_ = tag
	_ = trace
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]Item{{ID: "1", Name: "cup", Price: 9.5}})
}

func createItem(w http.ResponseWriter, r *http.Request) {
	var in ItemInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(ErrBody{Error: "bad body"})
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(Item{ID: "2", Name: in.Name, Price: in.Price})
}

func getItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "0" {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(ErrBody{Error: "missing"})
		return
	}
	_ = id
	_ = json.NewEncoder(w).Encode(Item{ID: id, Name: "cup"})
}

func downloadItem(w http.ResponseWriter, r *http.Request) {
	_ = r.PathValue("id")
	http.ServeFile(w, r, "files/item.pdf")
}

// health uses a legacy unmethoded registration, so the mux answers every verb.
func health(w http.ResponseWriter, r *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /items", listItems)
	mux.HandleFunc("POST /items", createItem)
	mux.HandleFunc("GET /items/{id}", getItem)
	mux.HandleFunc("GET /items/{id}/download", downloadItem)
	mux.HandleFunc("/health", health)

	// Mounted sub-mux under /admin.
	admin := http.NewServeMux()
	admin.HandleFunc("GET /admin/ping", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pong"))
	})
	mux.Handle("/admin/", admin)

	http.ListenAndServe(":8093", mux)
}
