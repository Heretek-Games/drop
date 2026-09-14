---
title: Ubuntu
---

To install drop-app on Ubuntu, simply download the deb package and open the downloaded file.
It will open it in the App Center. You can click Install on this page.

![Installing drop-app on the Ubuntu App Center](installing-drop-app-on-ubuntu-app-center.png)

## Installing from the PPA

Drop publishes a stable PPA and a rolling alpha PPA for Ubuntu. Install
`software-properties-common` if `add-apt-repository` is not already available:

```bash
sudo apt install software-properties-common
```

Stable channel:

```bash
sudo add-apt-repository ppa:heretek-games/drop
sudo apt update
sudo apt install drop-desktop-client
```

Alpha channel (bleeding-edge builds from every commit):

```bash
sudo add-apt-repository ppa:heretek-games/drop-alpha
sudo apt update
sudo apt install drop-desktop-client-alpha
```

## Uninstalling drop-app

To uninstall drop-app, you will need to open a terminal and run the following command:

```bash
sudo apt remove drop-desktop-client
```
