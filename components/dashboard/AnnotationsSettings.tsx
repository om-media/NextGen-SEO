import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Annotation, AnnotationsService } from "@/src/services/annotationsService"
import { CalendarDays, Plus, Trash2, Tag } from "lucide-react"
import { format, parseISO } from "date-fns"
import { useAuth } from "@/src/contexts/AuthContext"

interface AnnotationsSettingsProps {
  currentSiteUrl: string;
  annotations: Annotation[];
  onAnnotationsChange: () => void;
  showSystemAnnotations: boolean;
  setShowSystemAnnotations: (v: boolean) => void;
  showUserAnnotations: boolean;
  setShowUserAnnotations: (v: boolean) => void;
}

export function AnnotationsSettings({
  currentSiteUrl,
  annotations,
  onAnnotationsChange,
  showSystemAnnotations,
  setShowSystemAnnotations,
  showUserAnnotations,
  setShowUserAnnotations
}: AnnotationsSettingsProps) {
  const { user } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const systemAnnotations = annotations.filter((annotation) => annotation.type === 'system')
  const userAnnotations = annotations.filter((annotation) => annotation.type === 'user')
  
  const [newTitle, setNewTitle] = useState("")
  const [newDesc, setNewDesc] = useState("")
  const [newDate, setNewDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [siteSpecific, setSiteSpecific] = useState(true)
  const [loading, setLoading] = useState(false)

  const handleAdd = async () => {
    if (!user?.uid || !newTitle || !newDate) return;
    setLoading(true)
    try {
      await AnnotationsService.addAnnotation(user.uid, {
        title: newTitle,
        description: newDesc,
        date: newDate,
        siteUrl: siteSpecific ? currentSiteUrl : null,
        type: 'user'
      })
      setNewTitle("")
      setNewDesc("")
      setIsAdding(false)
      onAnnotationsChange()
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!user?.uid) return;
    try {
      await AnnotationsService.deleteAnnotation(user.uid, id)
      onAnnotationsChange()
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogTrigger render={<Button variant="outline" size="sm" className="h-9 gap-2 rounded-lg border-[#E6ECE8] bg-white shadow-sm" />}>
          <Tag className="w-4 h-4" />
          Annotations
          <span className="ml-1 rounded-full bg-[#EEF3FF] px-1.5 py-0.5 text-xs font-semibold text-[#2F7DF6]">
            {annotations.length}
          </span>
        </DialogTrigger>
      <DialogContent className="flex max-h-[84vh] w-[calc(100vw-32px)] max-w-[920px] flex-col gap-0 overflow-hidden rounded-3xl border-[#DDE7E1] p-0 shadow-[0_28px_90px_rgba(15,23,42,0.22)] sm:max-w-[920px]">
        <DialogHeader className="border-b border-[#E6ECE8] bg-white px-7 py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <DialogTitle className="text-xl tracking-[-0.02em] text-[#0F172A]">Annotations</DialogTitle>
              <p className="mt-1 max-w-xl text-sm leading-6 text-[#647067]">
                Control what appears on the chart, review Google updates, and add notes tied to this workspace.
              </p>
            </div>
            <div className="flex gap-2 text-xs font-medium text-[#334155]">
              <span className="rounded-full bg-[#EAF4EC] px-2.5 py-1">{systemAnnotations.length} Google</span>
              <span className="rounded-full bg-[#F3E8FF] px-2.5 py-1">{userAnnotations.length} Notes</span>
            </div>
          </div>
        </DialogHeader>
        
        <div className="flex flex-col gap-6 overflow-y-auto overflow-x-hidden bg-[#FBFCFB] px-5 py-5 sm:px-7 sm:py-6">
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <div className="min-w-0 rounded-2xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="show-sys" className="cursor-pointer font-semibold text-[#0F172A]">Google updates</Label>
                  <p className="mt-1 text-xs leading-5 text-[#647067]">Core updates and known Google events.</p>
                </div>
                <Switch checked={showSystemAnnotations} onCheckedChange={setShowSystemAnnotations} id="show-sys" />
              </div>
            </div>
            <div className="min-w-0 rounded-2xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="show-user" className="cursor-pointer font-semibold text-[#0F172A]">My notes</Label>
                  <p className="mt-1 text-xs leading-5 text-[#647067]">Launches, content changes, and team notes.</p>
                </div>
                <Switch checked={showUserAnnotations} onCheckedChange={setShowUserAnnotations} id="show-user" />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold tracking-[-0.01em] text-[#0F172A]">Workspace notes</h3>
              <p className="text-sm text-[#647067]">Add and manage custom notes for chart context.</p>
            </div>
            <Button onClick={() => setIsAdding(!isAdding)} variant={isAdding ? "secondary" : "default"} size="sm" className="gap-2">
              {isAdding ? "Cancel" : <><Plus className="w-4 h-4" /> Add Annotation</>}
            </Button>
          </div>

          {isAdding && (
            <div className="space-y-4 rounded-2xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input placeholder="e.g., Redesign Launch" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Description (Optional)</Label>
                <Textarea placeholder="Details about this event..." value={newDesc} onChange={e => setNewDesc(e.target.value)} />
              </div>
              <div className="flex items-center space-x-2 pt-2">
                <Switch checked={siteSpecific} onCheckedChange={setSiteSpecific} id="site-specific" />
                <Label htmlFor="site-specific" className="cursor-pointer">Apply only to {currentSiteUrl}</Label>
              </div>
              <div className="flex justify-end pt-2">
                <Button onClick={handleAdd} disabled={!newTitle || !newDate || loading}>Save Annotation</Button>
              </div>
            </div>
          )}

          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold uppercase tracking-[0.12em] text-[#647067]">My notes</h4>
                <span className="rounded-full bg-[#F3E8FF] px-2 py-0.5 text-xs font-semibold text-[#7C3AED]">{userAnnotations.length}</span>
              </div>
              {userAnnotations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-8 text-center text-sm text-muted-foreground">
                  No custom annotations for this view yet.
                </div>
              ) : (
                userAnnotations.map(ann => (
                  <div key={ann.id} className="group relative flex min-w-0 flex-col rounded-2xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
                    <div className="mb-2 flex justify-between gap-3">
                      <span className="inline-flex w-fit rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">Custom</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => handleDelete(ann.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    <h4 className="font-semibold text-foreground">{ann.title}</h4>
                    <span className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                      <CalendarDays className="w-3 h-3" />
                      {format(parseISO(ann.date), 'MMM d, yyyy')}
                    </span>
                    {ann.description && <p className="mt-2 text-sm leading-5 text-muted-foreground">{ann.description}</p>}
                    {ann.siteUrl && <span className="mt-3 block break-all border-t border-[#E6ECE8] pt-2 text-xs text-muted-foreground">Site: {ann.siteUrl}</span>}
                  </div>
                ))
              )}
            </section>

            <section className="min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold uppercase tracking-[0.12em] text-[#647067]">Google updates</h4>
                <span className="rounded-full bg-[#EEF3FF] px-2 py-0.5 text-xs font-semibold text-[#2F7DF6]">{systemAnnotations.length}</span>
              </div>
            {systemAnnotations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#D9E5DE] bg-white p-8 text-center text-sm text-muted-foreground">
                No annotations found for this view.
              </div>
            ) : (
              systemAnnotations.map(ann => (
                <div key={ann.id} className="group relative flex min-w-0 flex-col rounded-2xl border border-[#E6ECE8] bg-white p-4 shadow-sm">
                  <div className="flex justify-between items-start gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-700">
                        Google Update
                      </span>
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {format(parseISO(ann.date), 'MMM d, yyyy')}
                      </span>
                    </div>
                  </div>
                  <h4 className="font-semibold text-foreground">{ann.title}</h4>
                  {ann.description && <p className="text-sm text-muted-foreground mt-1">{ann.description}</p>}
                  {ann.siteUrl && <span className="text-xs text-muted-foreground mt-2 opacity-50 border-t border-[#E6ECE8] pt-2 block truncate">Site: {ann.siteUrl}</span>}
                </div>
              ))
            )}
            </section>
          </div>
        </div>
      </DialogContent>
      </Dialog>
      <div className="flex flex-wrap items-center gap-3 text-xs text-[#647067]">
        <label className="flex items-center gap-2">
          <Switch checked={showSystemAnnotations} onCheckedChange={setShowSystemAnnotations} />
          Google updates
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={showUserAnnotations} onCheckedChange={setShowUserAnnotations} />
          My notes
        </label>
      </div>
    </div>
  )
}
