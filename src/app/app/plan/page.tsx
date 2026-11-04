import { redirect } from "next/navigation";
import { APP_ROUTES } from "@/lib/public-urls";

/**
 * The Plan page is off for now (PM 11/4): planning lives in the pools page's "Calculate shares" dialog. Old `/app/plan`
 * links land on the pools list instead of a 404. `PlanApp` (src/components/plan/plan-app.tsx) is kept, so turning the
 * page back on is rendering it here again and restoring the nav link.
 */
export default function PlanPage() {
  redirect(APP_ROUTES.rwaPairs);
}
