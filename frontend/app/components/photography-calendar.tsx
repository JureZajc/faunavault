import Link from "next/link";
import { CalendarDay } from "../lib/api";
import { calendarDayHref, calendarDayLabel, calendarIntensity, calendarMonth, calendarThresholds } from "../lib/photo-calendar";
import { timelineMonthName } from "../lib/photo-timeline";

const activityClasses = ["bg-stone-100 text-stone-600", "bg-emerald-100 text-emerald-950", "bg-emerald-300 text-emerald-950", "bg-emerald-800 text-white"];
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default function PhotographyCalendar({ year, days, maximum }: { year: number; days: CalendarDay[]; maximum: number }) {
  const counts = new Map(days.map((day) => [day.date, day.photo_count]));
  const thresholds = calendarThresholds(maximum);
  return <section aria-label={`Daily photography calendar ${year}`} className="mt-6">
    <div aria-label="Photo activity legend" className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-stone-700">
      {["No Photos", `Low activity (1–${thresholds.low})`, `Medium activity (${thresholds.low + 1}–${thresholds.medium})`, `High activity (${thresholds.medium + 1}+)`].map((label, index) => <span key={label} className="inline-flex items-center gap-2"><span aria-hidden="true" className={`h-4 w-4 rounded border border-stone-300 ${activityClasses[index]}`} />{label}</span>)}
    </div>
    <p className="mb-5 text-xs leading-5 text-stone-600">Activity reflects photo counts within this year. A single photo is Low activity. Months start on Monday; underlined days open Photos in List.</p>
    <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 12 }, (_, index) => {
        const month = index + 1;
        const name = timelineMonthName(month);
        const calendar = calendarMonth(year, month);
        return <section key={month} aria-label={`${name} ${year}`} className="min-w-0 rounded-xl border border-stone-200 bg-white p-3 shadow-sm sm:p-4">
          <h3 className="mb-3 text-lg font-semibold">{name}</h3>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {weekdays.map((day) => <abbr key={day} title={day} className="py-2 font-medium text-stone-600 no-underline">{day.slice(0, 2)}</abbr>)}
            {Array.from({ length: calendar.offset }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
            {calendar.days.map((date) => {
              const count = counts.get(date) ?? 0;
              const label = calendarDayLabel(date, count);
              const intensity = calendarIntensity(count, maximum);
              const classes = `flex min-h-11 min-w-0 items-center justify-center rounded-md font-semibold tabular-nums ${activityClasses[intensity]}`;
              return count ? <Link key={date} prefetch={false} href={calendarDayHref(date)} aria-label={label} title={label} data-activity={intensity} className={`${classes} underline underline-offset-2 hover:ring-2 hover:ring-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700`}>{Number(date.slice(-2))}</Link> : <span key={date} title={label} data-activity="0" className={classes}><span aria-hidden="true">{Number(date.slice(-2))}</span><span className="sr-only">{label}</span></span>;
            })}
          </div>
        </section>;
      })}
    </div>
  </section>;
}
