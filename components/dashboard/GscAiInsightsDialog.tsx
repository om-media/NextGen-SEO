import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";
import Markdown from "react-markdown";

type GscAiInsightsDialogProps = {
  description: string;
  insights: string | null;
  isGenerating: boolean;
  onGenerate: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  error: string | null;
};

export function GscAiInsightsDialog({
  description,
  insights,
  isGenerating,
  onGenerate,
  onOpenChange,
  open,
  title,
  error,
}: GscAiInsightsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (nextOpen && !insights) {
          void onGenerate();
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="secondary" className="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border-indigo-200" />}>
        <Sparkles className="w-4 h-4 mr-2 text-indigo-500" />
        Analyze with AI
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="italic">{description}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          {isGenerating ? (
            <div className="flex flex-col items-center justify-center py-8 space-y-4">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="text-sm text-muted-foreground">Analyzing data and generating insights...</p>
            </div>
          ) : error ? (
            <div className="p-4 bg-destructive/10 text-destructive rounded-md text-sm">{error}</div>
          ) : insights ? (
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <Markdown>{insights}</Markdown>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void onGenerate()} disabled={isGenerating}>
            Regenerate
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
