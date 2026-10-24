package main

// Owner Tracker desktop EXE starts the local POS server and command receiver.
// Node.js 22.5+ must be installed or bundled at runtime/node.exe.
import (
 "fmt"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "time"
)
func main(){
 if runtime.GOOS!="windows" {fmt.Println("Windows only");return}
 own,err:=os.Executable();if err!=nil{fmt.Println(err);return}
 dir:=filepath.Dir(own)
 node:=filepath.Join(dir,"runtime","node.exe")
 if _,e:=os.Stat(node);e!=nil{
  n,e:=exec.LookPath("node.exe");if e!=nil{fmt.Println("ERROR: Node.js 22.5+ is required. Install Node.js 22 LTS for Windows x64, or copy node.exe into runtime\\node.exe");fmt.Println("Press Enter to exit");fmt.Scanln();return};node=n
 }
 if _,e:=os.Stat(filepath.Join(dir,"src","server.mjs"));e!=nil{fmt.Println("ERROR: Keep OwnerTrackerDesktop.exe inside the extracted Owner Tracker package, next to src folder");fmt.Scanln();return}
 logPath:=filepath.Join(dir,"data","desktop.log");os.MkdirAll(filepath.Dir(logPath),0700)
 log,e:=os.OpenFile(logPath,os.O_APPEND|os.O_CREATE|os.O_WRONLY,0600);if e!=nil{fmt.Println(e);return};defer log.Close()
 start:=func(script string)(*exec.Cmd,error){c:=exec.Command(node,script);c.Dir=dir;c.Stdout=log;c.Stderr=log;e:=c.Start();return c,e}
 server,e:=start(filepath.Join("src","server.mjs"));if e!=nil{fmt.Println("Failed to start server:",e);fmt.Scanln();return}
 agent,e:=start(filepath.Join("scripts","desktop-agent.mjs"));if e!=nil{fmt.Println("Desktop receiver start failed:",e)}
 fmt.Println("Owner Tracker V11 Desktop / POS running")
 fmt.Println("Open http://127.0.0.1:8787 for the full POS, or /owner.html and /tech.html for phone layouts")
 fmt.Println("Shop operations: http://127.0.0.1:8787/shop-ops.html")
 fmt.Println("Payments / DocuSign: http://127.0.0.1:8787/billing.html")
 fmt.Println("Leave this window open while shop staff use the system. Closing it stops the local server.")
 time.Sleep(1500*time.Millisecond)
 exec.Command("rundll32.exe","url.dll,FileProtocolHandler","http://127.0.0.1:8787").Start()
 e=server.Wait();fmt.Println("POS server stopped:",e)
 if agent!=nil && agent.Process!=nil {agent.Process.Kill();agent.Wait()}
 fmt.Println("Review log:",logPath);fmt.Println("Press Enter to exit");fmt.Scanln()
}
