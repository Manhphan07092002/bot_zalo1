#!/bin/bash
# Hướng dẫn chạy: chmod +x setup-ubuntu.sh && ./setup-ubuntu.sh

echo "Cập nhật danh sách gói..."
sudo apt-get update

echo "Cài đặt các thư viện cần thiết cho Puppeteer Chrome Headless trên Ubuntu..."
sudo apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  lsb-release \
  wget \
  xdg-utils

echo "Cài đặt Font cho tiếng Việt hiển thị trên PDF không bị lỗi..."
sudo apt-get install -y fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf

echo "Hoàn tất! Server của bạn đã sẵn sàng chạy Puppeteer."
