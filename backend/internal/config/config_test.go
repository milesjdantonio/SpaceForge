package config

import "testing"

func TestConfigurationSecurity(t *testing.T) {
	base := map[string]string{
		"APP_ENV": "development", "HTTP_ADDR": "127.0.0.1:8080",
		"DATABASE_URL": "postgres://local/db", "FIREBASE_PROJECT_ID": "demo-spaceforge",
		"FIREBASE_AUTH_EMULATOR_HOST": "127.0.0.1:9099",
	}
	tests := []struct {
		name   string
		change map[string]string
		valid  bool
	}{
		{"local emulator", nil, true},
		{"generation requires service token", map[string]string{"GENERATION_URL": "http://127.0.0.1:8000"}, false},
		{"private generation", map[string]string{"GENERATION_URL": "http://127.0.0.1:8000", "GENERATION_SERVICE_TOKEN": "test-service-token-at-least-32-characters"}, true},
		{"remote cleartext generation rejected", map[string]string{"GENERATION_URL": "http://worker.example", "GENERATION_SERVICE_TOKEN": "test-service-token-at-least-32-characters"}, false},
		{"generation URL cannot carry credentials", map[string]string{"GENERATION_URL": "https://user:password@worker.example", "GENERATION_SERVICE_TOKEN": "test-service-token-at-least-32-characters"}, false},
		{"generation workers bounded", map[string]string{"GENERATION_WORKERS": "0"}, false},
		{"production rejects emulator", map[string]string{"APP_ENV": "production"}, false},
		{"unset environment fails closed", map[string]string{"APP_ENV": ""}, false},
		{"unknown environment", map[string]string{"APP_ENV": "staging"}, false},
		{"public emulator", map[string]string{"FIREBASE_AUTH_EMULATOR_HOST": "0.0.0.0:9099"}, false},
		{"public API with emulator", map[string]string{"HTTP_ADDR": ":8080"}, false},
		{"real project with emulator", map[string]string{"FIREBASE_PROJECT_ID": "real-project"}, false},
		{"demo project without emulator", map[string]string{"FIREBASE_AUTH_EMULATOR_HOST": ""}, false},
		{"unbounded pool", map[string]string{"DB_MAX_CONNS": "1000"}, false},
		{"invalid API port", map[string]string{"HTTP_ADDR": "127.0.0.1:banana"}, false},
		{"invalid emulator port", map[string]string{"FIREBASE_AUTH_EMULATOR_HOST": "127.0.0.1:0"}, false},
		{"empty database", map[string]string{"DATABASE_URL": ""}, false},
		{"wildcard CORS", map[string]string{"ALLOWED_ORIGINS": "*"}, false},
		{"origin with path", map[string]string{"ALLOWED_ORIGINS": "http://localhost:5173/path"}, false},
		{"exact origins", map[string]string{"ALLOWED_ORIGINS": "http://localhost:5173,https://example.com"}, true},
		{"production HTTPS", map[string]string{"APP_ENV": "production", "FIREBASE_PROJECT_ID": "real-project", "FIREBASE_AUTH_EMULATOR_HOST": "", "ALLOWED_ORIGINS": "https://example.com"}, true},
		{"production HTTP rejected", map[string]string{"APP_ENV": "production", "FIREBASE_PROJECT_ID": "real-project", "FIREBASE_AUTH_EMULATOR_HOST": "", "ALLOWED_ORIGINS": "http://example.com"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			values := make(map[string]string)
			for k, v := range base {
				values[k] = v
			}
			for k, v := range tt.change {
				values[k] = v
			}
			_, err := Parse(func(key string) string { return values[key] })
			if (err == nil) != tt.valid {
				t.Fatalf("valid=%v, error=%v", tt.valid, err)
			}
		})
	}
}
