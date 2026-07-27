import type { QuotaTrendGraphPresentation } from "./panel-model";
import { trendTokens } from "./theme/tokens";

const TREND_TITLE_ID = "quota-trend-title";
const TREND_DESCRIPTION_ID = "quota-trend-description";

export function QuotaTrendGraph({
  presentation,
}: {
  presentation: QuotaTrendGraphPresentation;
}) {
  const hasActualLine = presentation.actualPath.length > 0;
  const hasProjection = presentation.projectionPath.length > 0;
  return (
    <div
      className={trendTokens.root}
      data-projection-kind={presentation.projectionKind}
      data-trend-points={presentation.pointCount}
      data-usage-trend=""
    >
      <div className={trendTokens.heading}>
        <span className={trendTokens.title}>
          {presentation.providerName} · {presentation.windowLabel}
        </span>
        <span className={trendTokens.status}>{presentation.statusLabel}</span>
      </div>
      <svg
        aria-labelledby={`${TREND_TITLE_ID} ${TREND_DESCRIPTION_ID}`}
        className={trendTokens.chart}
        role="img"
        viewBox="0 0 300 64"
      >
        <title id={TREND_TITLE_ID}>Current quota usage trend</title>
        <desc id={TREND_DESCRIPTION_ID}>{presentation.ariaLabel}</desc>
        <line
          className={trendTokens.guide}
          x1="4"
          x2="296"
          y1="26"
          y2="26"
        />
        <text className={trendTokens.guideLabel} x="6" y="23">
          50%
        </text>
        {hasActualLine ? (
          <path
            className={trendTokens.actual}
            d={presentation.actualPath}
            data-actual-trend=""
          />
        ) : null}
        {presentation.actualPoints.map((point, index) => (
          <circle
            className={trendTokens.point}
            cx={point.x}
            cy={point.y}
            key={`${point.x}:${point.y}:${index}`}
            r="1.6"
          />
        ))}
        {hasProjection ? (
          <path
            className={
              presentation.projectionKind === "last-estimate"
                ? trendTokens.lastEstimate
                : trendTokens.projection
            }
            d={presentation.projectionPath}
            data-runout-projection=""
          />
        ) : null}
        {!hasActualLine ? (
          <text
            className={trendTokens.placeholder}
            textAnchor="middle"
            x="150"
            y="34"
          >
            {presentation.statusLabel}
          </text>
        ) : null}
        {presentation.historyX !== undefined ? (
          <text className={trendTokens.axisLabel} x="4" y="61">
            history
          </text>
        ) : null}
        {presentation.nowX !== undefined ? (
          <text
            className={trendTokens.axisLabel}
            textAnchor="middle"
            x={presentation.nowX}
            y="61"
          >
            now
          </text>
        ) : null}
        {presentation.currentRemaining !== undefined ? (
          <text
            className={trendTokens.axisLabel}
            textAnchor="end"
            x="296"
            y="61"
          >
            reset
          </text>
        ) : null}
      </svg>
      <div aria-hidden="true" className={trendTokens.legend}>
        {presentation.pointCount > 0 ? (
          <span className={trendTokens.legendItem}>
            <span className={trendTokens.actualKey} /> history
          </span>
        ) : null}
        {hasProjection ? (
          <span className={trendTokens.legendItem}>
            <span
              className={
                presentation.projectionKind === "last-estimate"
                  ? trendTokens.lastEstimateKey
                  : trendTokens.projectionKey
              }
            />
            {presentation.projectionKind === "last-estimate"
              ? "last estimate"
              : "estimate"}
          </span>
        ) : null}
      </div>
    </div>
  );
}
