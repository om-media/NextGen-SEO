import * as React from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export function DatePicker({
  date,
  setDate,
  label = "Pick a date"
}: {
  date: Date | undefined
  setDate: (date: Date | undefined) => void
  label?: string
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button
        variant={"outline"}
        className={cn(
          "w-auto min-w-[160px] justify-start text-left font-normal",
          !date && "text-muted-foreground"
        )}
      />} >
        <CalendarIcon className="mr-2 h-4 w-4" />
        {date ? format(date, "PPP") : <span>{label}</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={date}
          onSelect={setDate}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  )
}
