import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "../../contexts/AuthContext"
import { AlertCircle, BarChart3, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

const SIGNED_OUT_NOTICE_SESSION_KEY = "signed_out_notice";

export function AuthScreen() {
  const { registerWithEmail, loginWithEmail } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [signedOutMessage, setSignedOutMessage] = useState("")

  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }

    if (window.sessionStorage.getItem(SIGNED_OUT_NOTICE_SESSION_KEY) === "true") {
      setSignedOutMessage("You've been signed out. Sign back in to return to your dashboard or continue onboarding.")
      window.sessionStorage.removeItem(SIGNED_OUT_NOTICE_SESSION_KEY)
    }
  }, [])

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      await registerWithEmail(email, password)
    } catch (err: any) {
      if (err.code === 'EMAIL_ALREADY_IN_USE') {
        setError("This email already belongs to an existing account. Sign in instead, or use a different email for a new workspace.")
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      await loginWithEmail(email, password)
    } catch (err: any) {
      if (err.code === 'INVALID_LOGIN' || err.code === 'PASSWORD_NOT_SET') {
        setError("We couldn't sign you in with that email and password. If this email belongs to an older Google-created account, registering once with a local password will claim it for local sign-in.")
      } else {
        setError(err.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleProviderAuth = (provider: "Google" | "Microsoft") => {
    toast.info(`${provider} app sign-in is not configured yet`, {
      description: "Use email and password for now. Search Console, GA4, and Bing data connections stay separate after login.",
    })
  }

  const ProviderButtons = ({ mode }: { mode: "login" | "register" }) => (
    <div className="w-full space-y-3">
      <div className="relative py-1 text-center">
        <div className="absolute inset-x-0 top-1/2 h-px bg-[#E6ECE8]" />
        <span className="relative bg-white px-3 text-xs font-medium text-[#647067]">
          or {mode === "login" ? "sign in" : "register"} with
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-2xl border-[#E6ECE8] bg-white text-[#0F172A] shadow-sm hover:bg-[#FBFCFB]"
          onClick={() => handleProviderAuth("Google")}
        >
          <span className="mr-2 flex h-5 w-5 items-center justify-center rounded-full border border-[#E6ECE8] text-[11px] font-bold text-[#4285F4]">
            G
          </span>
          Google
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11 rounded-2xl border-[#E6ECE8] bg-white text-[#0F172A] shadow-sm hover:bg-[#FBFCFB]"
          onClick={() => handleProviderAuth("Microsoft")}
        >
          <span className="mr-2 grid h-4 w-4 grid-cols-2 gap-0.5">
            <span className="bg-[#F25022]" />
            <span className="bg-[#7FBA00]" />
            <span className="bg-[#00A4EF]" />
            <span className="bg-[#FFB900]" />
          </span>
          Microsoft
        </Button>
      </div>
    </div>
  )

  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-[#F8FAF9] p-4 sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(15,61,46,0.12),transparent_28%),radial-gradient(circle_at_82%_72%,rgba(47,125,246,0.10),transparent_34%),linear-gradient(180deg,#FBFCFB_0%,#F8FAF9_52%,#F4F8F7_100%)]" />
      <div className="pointer-events-none absolute -bottom-24 right-[-8%] h-[520px] w-[720px] rounded-full bg-[#EAF4EC]/70 blur-3xl" />
      <div className="relative grid w-full max-w-6xl overflow-hidden rounded-[28px] border border-[#E6ECE8] bg-white/80 shadow-[0_30px_90px_rgba(15,61,46,0.14)] backdrop-blur-xl lg:grid-cols-[0.95fr_1fr]">
        <section className="relative hidden min-h-[660px] overflow-hidden border-r border-[#E6ECE8] bg-[#FBFCFB] p-10 lg:block">
          <div className="relative z-10 flex h-full flex-col justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-[#0F3D2E] p-3 text-white shadow-[0_16px_32px_rgba(15,61,46,0.20)]">
                  <BarChart3 className="h-7 w-7" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#647067]">NextGen SEO</p>
                  <p className="text-lg font-semibold text-[#0F172A]">Search intelligence</p>
                </div>
              </div>

              <div className="mt-20 max-w-md">
                <p className="text-sm font-semibold text-[#0F3D2E]">Create your workspace</p>
                <h1 className="mt-3 text-5xl font-semibold leading-[0.98] tracking-[-0.045em] text-[#0F172A]">
                  Start with a clean local account.
                </h1>
                <p className="mt-5 text-base leading-7 text-[#647067]">
                  Search Console, GA4, and Bing are connected after account creation, so signing up can start with email and password.
                </p>
              </div>
            </div>

            <div className="grid gap-3">
              {["Email and password login", "Search Console, GA4, and Bing connected later", "First site chosen during setup"].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-2xl border border-[#E6ECE8] bg-white/80 px-4 py-3 text-sm font-medium text-[#0F172A]">
                  <CheckCircle2 className="h-4 w-4 text-[#0F3D2E]" />
                  {item}
                </div>
              ))}
            </div>
          </div>
          <img
            src="/images/hero-mountains.png"
            alt=""
            className="pointer-events-none absolute bottom-0 right-[-170px] w-[760px] max-w-none opacity-75"
          />
        </section>

        <section className="relative p-6 sm:p-10">
          <div className="mx-auto w-full max-w-md space-y-6">
            <div className="space-y-3 lg:hidden">
              <div className="rounded-2xl bg-[#0F3D2E] p-3 text-white shadow-[0_16px_32px_rgba(15,61,46,0.20)]">
                <BarChart3 className="h-8 w-8" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#647067]">NextGen SEO</p>
                <h1 className="mt-1 text-3xl font-semibold tracking-[-0.03em] text-[#0F172A]">Create your workspace</h1>
              </div>
            </div>
            <div className="hidden lg:block">
              <p className="text-sm font-semibold text-[#0F3D2E]">Workspace login</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-[#0F172A]">Sign in or create an account</h2>
              <p className="mt-2 text-sm leading-6 text-[#647067]">
                Use email first, or continue with a provider below. Reporting data connections happen after registration.
              </p>
            </div>

        {signedOutMessage && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-900 shadow-sm">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{signedOutMessage}</p>
            </div>
          </div>
        )}

        <Tabs defaultValue="login" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-2xl border border-[#E6ECE8] bg-white/80 p-1 shadow-sm">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
          
          <TabsContent value="login">
            <Card className="overflow-hidden rounded-2xl border-[#E6ECE8] bg-white/92 shadow-[0_20px_60px_rgba(15,61,46,0.10)] backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Welcome back</CardTitle>
                <CardDescription>Enter your workspace email and password.</CardDescription>
              </CardHeader>
              <form onSubmit={handleLogin}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input id="password" type="password" required value={password} onChange={e => setPassword(e.target.value)} />
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </CardContent>
                <CardFooter className="flex flex-col space-y-4">
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Signing in..." : "Sign in"}
                  </Button>
                  <ProviderButtons mode="login" />
                  <p className="text-center text-xs text-muted-foreground">Search Console, GA4, and Bing access are separate from app login.</p>
                </CardFooter>
              </form>
            </Card>
          </TabsContent>

          <TabsContent value="register">
            <Card className="overflow-hidden rounded-2xl border-[#E6ECE8] bg-white/92 shadow-[0_20px_60px_rgba(15,61,46,0.10)] backdrop-blur-xl">
              <CardHeader>
                <CardTitle>Create your workspace</CardTitle>
                <CardDescription>Start with email and password. Connect Search Console, GA4, and Bing after this step.</CardDescription>
              </CardHeader>
              <form onSubmit={handleRegister}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reg-email">Email</Label>
                    <Input id="reg-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="reg-password">Password</Label>
                    <Input id="reg-password" type="password" required minLength={10} value={password} onChange={e => setPassword(e.target.value)} />
                  </div>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </CardContent>
                <CardFooter className="flex flex-col space-y-4">
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? "Creating account..." : "Create account"}
                  </Button>
                  <ProviderButtons mode="register" />
                  <p className="text-center text-xs text-muted-foreground">This creates an app login. Reporting connections are configured during onboarding.</p>
                </CardFooter>
              </form>
            </Card>
          </TabsContent>
        </Tabs>
          </div>
        </section>
      </div>
    </div>
  )
}
