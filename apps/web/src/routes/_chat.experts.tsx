import { createFileRoute } from "@tanstack/react-router";

import { ExpertsFeedView } from "../components/experts/ExpertsFeedView";

export const Route = createFileRoute("/_chat/experts")({
  component: ExpertsFeedView,
});
