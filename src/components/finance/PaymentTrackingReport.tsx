import { useState } from 'react';
import { toast } from 'sonner';
import { FileSpreadsheet, Loader2, CheckCircle2, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';

export default function PaymentTrackingReport() {
  const [fileId, setFileId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ sheetId: string; invoices: number; cells: number; flagged: number; movedTo?: string } | null>(null);

  const handleGenerate = async () => {
    const trimmedId = fileId.trim();
    if (!trimmedId) return;

    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('fill-payment-tracking', {
        body: { fileId: trimmedId },
      });

      if (error) throw error;
      if (!data?.ok || !data?.sheetId) {
        throw new Error(data?.error || 'Generation failed: missing sheetId in response');
      }

      setResult({
        sheetId: data.sheetId,
        invoices: data.invoices ?? 0,
        cells: data.cells ?? 0,
        flagged: data.flagged ?? 0,
        movedTo: data.movedTo,
      });
      setFileId('');
      toast.success('Payment tracking sheet generated');
    } catch (err: any) {
      const message = err?.message || 'Failed to generate payment tracking sheet';
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const sheetUrl = result ? `https://docs.google.com/spreadsheets/d/${result.sheetId}/edit` : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Payment Tracking Report
          </CardTitle>
          <CardDescription>
            Paste the Google Drive file ID of the source spreadsheet (the Drive mirror file). A new payment tracking sheet will be generated and moved into the current month's folder.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="source-file-id">Source File ID</Label>
            <Input
              id="source-file-id"
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
              placeholder="1Ah5ScUN7tI06JT7qpTeuc6Xi1SoGEXGlzq7nqcAfheA"
              disabled={generating}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The file ID is the long alphanumeric string in the Google Drive URL between <code>/d/</code> and <code>/edit</code>.
            </p>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={!fileId.trim() || generating}
            className="w-full sm:w-auto"
          >
            {generating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating... (this may take 20-30 seconds)
              </>
            ) : (
              <>
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Generate
              </>
            )}
          </Button>

          {result && sheetUrl && (
            <div className="rounded-md border border-green-200 bg-green-50 p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 shrink-0" />
                <div className="flex-1 space-y-2">
                  <p className="text-sm font-medium text-green-900">Output sheet ready</p>
                  <p className="text-xs text-green-800">
                    {result.invoices} invoices · {result.cells} cells filled
                    {result.flagged > 0 ? ` · ${result.flagged} flagged` : ''}
                    {result.movedTo ? ` · moved to month folder` : ''}
                  </p>
                  <a
                    href={sheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 hover:text-green-900 hover:underline"
                  >
                    Open payment tracking sheet
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
