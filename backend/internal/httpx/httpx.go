package httpx

import (
	"context"
	"encoding/json"
	"net/http"
)

type requestIDKey struct{}

func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Error(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	JSON(w, status, map[string]any{"error": map[string]string{
		"code": code, "message": message, "request_id": RequestID(r.Context()),
	}})
}
