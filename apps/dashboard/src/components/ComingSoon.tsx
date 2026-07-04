/** Honest placeholder for a secondary screen not yet wired to a real op (no fabricated data). */
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"

export function ComingSoon({
  title,
  version,
  blurb,
}: {
  title: string
  version: string
  blurb: string
}) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Coming in {version}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted text-sm">{blurb}</p>
        </CardContent>
      </Card>
    </div>
  )
}
