import { Router } from "express";
import { getContainerDriver } from "../scheduler/container";

const router = Router();

router.get("/:file", async (req, res) => {
  try {
    const driver = getContainerDriver();
    const endpoint = await driver.getWorkerEndpoint("default");
    const response = await fetch(`${endpoint.url}/workspace/${req.params.file}`);
    if (!response.ok) return res.status(response.status).json({ content: "" });
    res.json(await response.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:file", async (req, res) => {
  try {
    const driver = getContainerDriver();
    const endpoint = await driver.getWorkerEndpoint("default");
    const response = await fetch(`${endpoint.url}/workspace/${req.params.file}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!response.ok) return res.status(response.status).json({ success: false });
    res.json(await response.json());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
