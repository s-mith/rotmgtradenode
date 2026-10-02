# Questions and answers

## Is this safe for my main account?

Never add your main account. Use alt accounts made only for this. Bot accounts can be banned by Realm, so treat every account you add as one you could lose. Proxies keep your bots apart from the home internet address your main account uses.

## Do I need proxies?

They are recommended. A proxy is an internet address you rent; each bot logs in through its own one, so Realm does not see all your bots coming from your home connection. Without proxies you can use your own internet, but then only one bot logs in at a time, and your bots share your home address with your main account.

## What kind of proxies do I need?

**SOCKS5** proxies, ideally **dedicated** (not shared with other people). The node speaks SOCKS5 only: a line written as `http://…` is tried as SOCKS5 on the same port, which many sellers allow, and **Test my proxies** tells you whether yours does. Paste the list exactly as the seller gives it: lines like `1.2.3.4:1080:username:password` or `username:password@1.2.3.4:1080` both work. Press **Test my proxies** to see which ones work.

## My bots are not logging in. What do I check?

1. Look at the status card at the top of the control panel. It names the problem and has a button to fix it.
2. **Proxies:** open the Proxies tab and press **Test my proxies**. If none work, check the list with your proxy seller.
3. **Accounts:** the Accounts tab marks an account whose password is wrong or that Realm suspended.
4. **Realm updated the game:** logins pause until the rotmg trade team confirms the new version (or an app update brings it). The status card says so; nothing to do.
5. **Your PC slept or lost internet:** the bots come back by themselves once the PC is awake and online.

## Why do my bots keep logging in and out?

That is normal. A bot logs in when someone wants to trade, does the trade, and logs out. Less time online means less risk and less load on your PC.

## Can I close the window?

Yes. The node keeps running in the tray, near the clock. To stop it, right-click the tray icon and choose **Quit**.

## Does it run while my PC is asleep?

No. Keep the PC awake while you want people to trade: Control panel → Help → App settings → **Keep this PC awake while the node runs**.

## "Windows protected your PC" — is that a virus?

No. The app is not signed with a publisher certificate yet, so Windows does not know who made it ("Unknown publisher") and shows that screen. If you downloaded the installer from the official link on rotmg trade or our Discord, click **More info**, then **Run anyway**. If you are not sure where the file came from, delete it. You only see this when you install: updates install without it.

## My browser says the installer "isn't commonly downloaded"

Browsers say that about new files few people have downloaded yet. If it came from the official link, keep it. In Edge, press **…** next to the download, then **Keep**, **Show more** and **Keep anyway**. In Chrome, press **Keep**.

## "Smart App Control blocked an app that may be unsafe"

Smart App Control is a Windows 11 security setting that blocks every app without a publisher signature, and it has no **Run anyway**. While it is on, the node cannot be installed on that PC. Windows only allows it if you turn Smart App Control off (Windows Security → App & browser control → Smart App Control settings). That is your decision: on some versions of Windows it cannot be turned back on without resetting Windows. A signed version of the app, planned for later, will not have this problem.

## How do I update?

You do not need to: the app downloads new versions by itself and installs them the next time you quit.

## Where is my data, and how do I uninstall?

Your accounts, settings and logs are in a data folder in your Windows user profile (Control panel → Help → **Open data folder**). Uninstall from Windows Settings → Apps → rotmgtradenode. Uninstalling keeps your data folder, so a reinstall picks up where you left off; delete the folder yourself if you want everything gone.

## What is "Advanced management"?

An optional feature for nodes with many accounts. It keeps items tidy in the background so trades are quicker, but bots log in more often. It is off by default; leave it off unless you know you want it.

## How do I get help?

Control panel → **Help** → **Copy diagnostics**, then paste it in the help channel on our Discord. Passwords, emails and proxy logins are removed first.
