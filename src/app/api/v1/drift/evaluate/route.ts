import { config } from "@/lib/config";
import { evaluateDrift, isDriftSample, MAX_DRIFT_VALUES } from "@/lib/floodfund/drift";
import { fail, ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body: unknown = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => !["reference", "current", "bins"].includes(key))) {
    return fail(400, "invalid_drift_input", "Supply reference and current arrays and optional bins.");
  }
  const { reference, current, bins = config.drift.bins } = body as Record<string, unknown>;
  if (!isDriftSample(reference) || !isDriftSample(current)) {
    return fail(400, "invalid_drift_input", `Each array must contain at most ${MAX_DRIFT_VALUES} finite numbers.`);
  }
  if (typeof bins !== "number" || !Number.isInteger(bins) || bins < 2 || bins > 50) {
    return fail(400, "invalid_drift_input", "bins must be a whole number between 2 and 50.");
  }
  const result = evaluateDrift({ reference: { input: reference }, current: { input: current } }, { ...config.drift, bins });
  const { psi, ksD, ksPValue } = result.features[0];
  return ok({ ...result, dataKind: "provided", psi, ksD, ksPValue });
}
