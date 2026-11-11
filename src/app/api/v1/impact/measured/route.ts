import { getMeasuredImpact } from "@/lib/floodfund/impact-data";
import { handle, ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => ok(await getMeasuredImpact()));
}
