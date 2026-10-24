
import json
from pathlib import Path


def estimate_house(design, pricing):
    """Estimate construction cost from design quantities and unit prices."""

    material_rows = []
    material_total = 0.0

    # Calculate material costs
    user_quantities = design.get("user_material_quantities", {})

    for material in design.get("materials", []):
        name = material["name"]
        key = name.lower()
        unit = material["unit"]

        if key not in pricing["materials"]:
            raise ValueError(f"Missing price for material: {name}")

        price_info = pricing["materials"][key]

        if price_info["unit"] != unit:
            raise ValueError(f"Unit mismatch for material: {name}")

        quantity = user_quantities.get(
            key,
            material.get("quantity", material.get("suggested_quantity"))
        )

        if quantity is None or quantity < 0:
            raise ValueError(f"Invalid quantity for material: {name}")

        unit_price = price_info["unit_price"]
        waste_rate = price_info.get(
            "waste_rate", pricing.get("default_waste_rate", 0.05)
        )

        purchase_quantity = quantity * (1 + waste_rate)
        cost = purchase_quantity * unit_price
        material_total += cost

        material_rows.append({
            "name": name,
            "quantity_required": quantity,
            "quantity_to_purchase": round(purchase_quantity, 3),
            "unit": unit,
            "unit_price": unit_price,
            "estimated_cost": round(cost, 2)
        })

    # Calculate labor costs
    labor_total = sum(
        task["hours"] * task["hourly_rate"]
        for task in design.get("labor", [])
    )

    # Other direct construction expenses
    site = design.get("site_work_cost", 0)
    equipment = design.get("equipment_cost", 0)
    permits = design.get("permit_cost", 0)
    other = design.get("other_cost", 0)

    direct_cost = (
        material_total + labor_total
        + site + equipment + permits + other
    )

    overhead_rate = pricing.get("overhead_rate", 0.10)
    profit_rate = pricing.get("profit_rate", 0.08)
    contingency_rate = pricing.get("contingency_rate", 0.10)

    overhead = direct_cost * overhead_rate
    profit = (direct_cost + overhead) * profit_rate
    subtotal = direct_cost + overhead + profit
    contingency = subtotal * contingency_rate
    total = subtotal + contingency

    return {
        "design_id": design.get("design_id", "unknown"),
        "currency": design.get("currency", "USD"),
        "materials": material_rows,
        "cost_breakdown": {
            "materials": round(material_total, 2),
            "labor": round(labor_total, 2),
            "site_work": round(site, 2),
            "equipment": round(equipment, 2),
            "permits": round(permits, 2),
            "other": round(other, 2),
            "direct_cost": round(direct_cost, 2),
            "overhead": round(overhead, 2),
            "profit": round(profit, 2),
            "contingency": round(contingency, 2),
            "total_estimated_construction_cost": round(total, 2)
        }
    }


def main():
    design = json.loads(
        Path("data/house_design.json").read_text()
    )
    pricing = json.loads(
        Path("data/pricing.json").read_text()
    )

    estimate = estimate_house(design, pricing)

    output = Path("outputs/house_estimate.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(estimate, indent=2))

    print(f"Estimate saved to {output}")
    print(
        "Estimated total:",
        estimate["currency"],
        estimate["cost_breakdown"][
            "total_estimated_construction_cost"
        ]
    )


if __name__ == "__main__":
    main()
