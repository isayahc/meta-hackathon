#!/bin/bash

# Exit on error
set -e

echo "🚀 Installing DexScreener MCP Server..."

# Create MCP directory if it doesn't exist
MCP_DIR="$HOME/Documents/Cline/MCP"
mkdir -p "$MCP_DIR"
cd "$MCP_DIR"

# Clone the repository
echo "📦 Cloning repository..."
git clone https://github.com/yourusername/meta-hackathon.git
cd meta-hackathon

# Install dependencies and build
echo "🔧 Installing dependencies..."
npm install

echo "🛠️ Building project..."
npm run build

# Run setup script
echo "⚙️ Configuring Claude Desktop..."
npm run setup

echo "✅ Installation complete! Please restart Claude Desktop to activate the server."
