# What the interface needs from the Gemma system

TerraSim's Gemma system designs the buildings. The website collects the land and the brief, sends
them, and draws exactly what comes back. The contract between the two is in [contracts/](contracts/):

| File | What it is |
|---|---|
| [baseline.json](contracts/baseline.json) | The blank template: the `request` Gemma receives, and the `design` (render file) and `estimate` it returns. |
| [FIELDS.md](contracts/FIELDS.md) | Every field explained, the housing types, and the rules the renderer checks. |
| [GEMMA_PROMPT.md](contracts/GEMMA_PROMPT.md) | The instructions to give Gemma: what each user answer means and the order to work in. |
| [STORAGE.md](contracts/STORAGE.md) | The plan for storing requests, designs and estimates, and the endpoints the website calls. |

How to point the website at a running design service, and what replies it accepts, is in the
[README](README.md#test-the-ai-gemma-in-the-website).

The one sample design, [frontend/fixtures/mock-house/design.json](frontend/fixtures/mock-house/design.json),
is a complete `terrasim.design/2` file to compare Gemma's output against.
