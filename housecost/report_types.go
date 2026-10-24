package main

// Report is the extra section of the output file: site data, the decisions,
// the materials list with suppliers, the cost build-up and nearby suppliers.
type Report struct {
	Schema      string        `json:"schema"`
	Verdict     string        `json:"verdict"`
	Problems    []string      `json:"problems,omitempty"`
	Site        *Site         `json:"site,omitempty"`
	Assessment  *ReportAssess `json:"assessment,omitempty"`
	LineItems   []ReportLine  `json:"lineItems"`
	CostSummary *CostSummary  `json:"costSummary,omitempty"`
	Suppliers   []Supplier    `json:"suppliers"`
	Warnings    []string      `json:"warnings"`
	GemmaLog    string        `json:"gemmaLog,omitempty"`
}

type ReportAssess struct {
	Feasibility         string   `json:"feasibility"`
	FoundationType      string   `json:"foundationType"`
	FoundationRationale string   `json:"foundationRationale"`
	PresumptiveBearing  *int     `json:"presumptiveBearingPsf"`
	RetainingWallNeeded bool     `json:"retainingWallNeeded"`
	Risks               []string `json:"risks"`
}

type ReportLine struct {
	ID          string  `json:"id"`
	CatalogID   string  `json:"catalogId"`
	Category    string  `json:"category"`
	RoomType    string  `json:"roomType,omitempty"`
	Name        string  `json:"name"`
	Quantity    float64 `json:"quantity"`
	Unit        string  `json:"unit"`
	UnitCost    float64 `json:"unitCost"`
	Cost        float64 `json:"cost"`
	Installed   bool    `json:"installed"`
	PriceSource string  `json:"priceSource"`
	BuyAt       string  `json:"buyAt"`
	Reason      string  `json:"reason"`
}

type CostSummary struct {
	Materials     float64  `json:"materials"`
	InstalledWork float64  `json:"installedWork"`
	Labor         float64  `json:"labor"`
	SiteWork      float64  `json:"siteWork"`
	Overhead      float64  `json:"overheadAndProfit"`
	Permits       float64  `json:"permitsAndDesign"`
	Total         float64  `json:"total"`
	PerSqFt       float64  `json:"perSqFt"`
	PerM2         float64  `json:"perM2"`
	WageFactor    float64  `json:"wageFactor"`
	BudgetUSD     *float64 `json:"budgetUSD"`
	OverBudgetBy  *float64 `json:"overBudgetBy"`
}
