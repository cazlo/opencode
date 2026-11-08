export function formatSessionDuration(start: number | undefined, end: number | undefined, locale: string) {
  if (!start || !end || end < start) return "—"

  const unit = (value: number, name: "second" | "minute" | "hour" | "day") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "narrow" }).format(value)

  const totalSeconds = Math.floor((end - start) / 1000)

  if (totalSeconds < 60) return unit(totalSeconds, "second")

  const totalMinutes = Math.floor(totalSeconds / 60)

  if (totalMinutes < 60) return unit(totalMinutes, "minute")

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours < 24) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")

  const days = Math.floor(hours / 24)
  const remHours = hours % 24

  return remHours > 0 ? `${unit(days, "day")} ${unit(remHours, "hour")}` : unit(days, "day")
}

export function createSessionContextFormatter(locale: string) {
  // The fields luxon's DATETIME_MED preset passed to Intl; output is identical.
  const dateTime = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  })

  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 })
  const percent = new Intl.NumberFormat(locale, { style: "percent" })

  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"

      if (value === null) return "—"

      return value.toLocaleString(locale)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"

      if (value === null) return "—"

      return percent.format(value / 100)
    },
    compactTokens(value: number) {
      return compact.format(Number.isFinite(value) && value > 0 ? value : 0)
    },
    time(value: number | undefined) {
      if (!value) return "—"

      return dateTime.format(value)
    },
    duration(start: number | undefined, end: number | undefined) {
      return formatSessionDuration(start, end, locale)
    },
  }
}
