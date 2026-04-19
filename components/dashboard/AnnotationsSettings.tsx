import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Annotation, AnnotationsService } from "@/src/services/annotationsService"
import { CalendarDays, Plus, Trash2, Tag } from "lucide-react"
import { format, parseISO } from "date-fns"
import { useAuth } from "@/src/contexts/AuthContext"
import { cn } from "@/lib/utils"

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
  const { userProfile, user } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  
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
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="gap-2" />}>
        <Tag className="w-4 h-4" />
        Annotations
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Annotations</DialogTitle>
        </DialogHeader>
        
        <div className="flex flex-col gap-6 overflow-y-auto pr-2 py-4">
          <div className="flex items-center gap-6 p-4 rounded-md bg-muted/30 border">
            <div className="flex items-center space-x-2">
              <Switch checked={showSystemAnnotations} onCheckedChange={setShowSystemAnnotations} id="show-sys" />
              <Label htmlFor="show-sys" className="cursor-pointer">Show Google Updates</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Switch checked={showUserAnnotations} onCheckedChange={setShowUserAnnotations} id="show-user" />
              <Label htmlFor="show-user" className="cursor-pointer">Show User Annotations</Label>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-lg font-medium">Your Annotations</h3>
            <Button onClick={() => setIsAdding(!isAdding)} variant={isAdding ? "secondary" : "default"} size="sm" className="gap-2">
              {isAdding ? "Cancel" : <><Plus className="w-4 h-4" /> Add Annotation</>}
            </Button>
          </div>

          {isAdding && (
            <div className="p-4 border rounded-md space-y-4 bg-muted/20">
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

          <div className="space-y-3">
            {annotations.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground border rounded-md bg-muted/10">
                No annotations found for this view.
              </div>
            ) : (
              annotations.map(ann => (
                <div key={ann.id} className="flex flex-col p-4 border rounded-md bg-card relative shadow-sm group">
                  <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${ann.type === 'system' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {ann.type === 'system' ? 'Google Update' : 'Custom'}
                      </span>
                      <span className="text-sm text-muted-foreground flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {format(parseISO(ann.date), 'MMM d, yyyy')}
                      </span>
                    </div>
                    {ann.type === 'user' && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => handleDelete(ann.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <h4 className="font-semibold text-foreground">{ann.title}</h4>
                  {ann.description && <p className="text-sm text-muted-foreground mt-1">{ann.description}</p>}
                  {ann.siteUrl && <span className="text-xs text-muted-foreground mt-2 opacity-50 border-t pt-2 block truncate">Site: {ann.siteUrl}</span>}
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
