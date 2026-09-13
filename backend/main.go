package main

import (
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/gorilla/mux"
)

func handler(res http.ResponseWriter, req *http.Request) {
	fmt.Fprintf(res, "G'day there mate")
}
func routingMiddleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		url := *r.URL
		url.Path = strings.TrimSuffix(r.URL.Path, "/")
		r.URL = &url // NOSONAR: no outbound request is made; URL is only rewritten for the router

		h.ServeHTTP(w, r)
	})
}

func main() {
	r := mux.NewRouter().StrictSlash(true)
	r.Use(routingMiddleware)

	r.HandleFunc("/api/v1", handler)

	srv := &http.Server{
		Addr:    ":3433",
		Handler: r,
	}
	log.Printf("starting drop server on :3433")
	srv.ListenAndServe()
}
