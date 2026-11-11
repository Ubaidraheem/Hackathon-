import { getDriftStatus } from "@/lib/floodfund/drift-monitor";
import { handle, ok } from "@/lib/floodfund/respond";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => ok(await getDriftStatus()));
}
