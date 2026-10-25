package config

import (
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Environment       string
	HTTPAddr          string
	DatabaseURL       string
	DBMaxConns        int32
	Origins           []string
	ProjectID         string
	EmulatorHost      string
	GenerationURL     string
	GenerationToken   string
	GenerationWorkers int
}

func Load() (Config, error) { return Parse(os.Getenv) }

// Parse receives environment lookup explicitly so security defaults can be tested.
func Parse(get func(string) string) (Config, error) {
	c := Config{
		Environment: get("APP_ENV"), HTTPAddr: get("HTTP_ADDR"),
		DatabaseURL: get("DATABASE_URL"), ProjectID: get("FIREBASE_PROJECT_ID"),
		EmulatorHost: get("FIREBASE_AUTH_EMULATOR_HOST"), DBMaxConns: 5,
		GenerationURL: strings.TrimRight(get("GENERATION_URL"), "/"), GenerationToken: get("GENERATION_SERVICE_TOKEN"), GenerationWorkers: 2,
	}
	if c.Environment == "" {
		c.Environment = "production"
	}
	if c.Environment != "development" && c.Environment != "test" && c.Environment != "production" {
		return c, errors.New("APP_ENV must be development, test, or production")
	}
	if c.GenerationURL != "" {
		u, err := url.Parse(c.GenerationURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()))) {
			return c, errors.New("GENERATION_URL must be an HTTPS origin or explicit loopback HTTP origin")
		}
		if len(c.GenerationToken) < 32 {
			return c, errors.New("GENERATION_SERVICE_TOKEN must contain at least 32 characters when generation is enabled")
		}
	}
	if raw := get("GENERATION_WORKERS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 16 {
			return c, errors.New("GENERATION_WORKERS must be between 1 and 16")
		}
		c.GenerationWorkers = n
	}
	if c.HTTPAddr == "" {
		port := get("PORT")
		if port == "" {
			port = "8080"
		}
		c.HTTPAddr = ":" + port
	}
	if !validAddress(c.HTTPAddr) {
		return c, errors.New("HTTP_ADDR must be host:port")
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	if c.ProjectID == "" {
		return c, errors.New("FIREBASE_PROJECT_ID is required")
	}
	if raw := get("DB_MAX_CONNS"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || n < 1 || n > 100 {
			return c, errors.New("DB_MAX_CONNS must be between 1 and 100")
		}
		c.DBMaxConns = int32(n)
	}
	if c.EmulatorHost != "" {
		if c.Environment != "development" && c.Environment != "test" {
			return c, errors.New("Firebase Auth emulator is forbidden outside development/test")
		}
		if !strings.HasPrefix(c.ProjectID, "demo-") {
			return c, errors.New("emulator requires a demo- Firebase project ID")
		}
		if !validAddress(c.EmulatorHost) || !loopbackAddress(c.EmulatorHost) || !loopbackAddress(c.HTTPAddr) {
			return c, errors.New("emulator and API must bind to explicit loopback addresses")
		}
	} else if strings.HasPrefix(c.ProjectID, "demo-") {
		return c, errors.New("demo- Firebase projects require the local Auth emulator")
	}
	for _, raw := range strings.Split(get("ALLOWED_ORIGINS"), ",") {
		origin := strings.TrimSpace(raw)
		if origin == "" {
			continue
		}
		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "http" && u.Scheme != "https") {
			return c, errors.New("ALLOWED_ORIGINS must contain exact http(s) origins without paths")
		}
		if c.Environment == "production" && u.Scheme != "https" {
			return c, errors.New("production origins must use https")
		}
		c.Origins = append(c.Origins, origin)
	}
	return c, nil
}

func loopbackAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

func validAddress(address string) bool {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}
