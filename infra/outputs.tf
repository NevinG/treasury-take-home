output "app_name" {
  description = "Web app name — set this as the GitHub Actions variable AZURE_WEBAPP_NAME."
  value       = azurerm_linux_web_app.app.name
}

output "app_url" {
  description = "Public URL of the deployed app."
  value       = "https://${azurerm_linux_web_app.app.default_hostname}"
}

output "resource_group" {
  value = azurerm_resource_group.rg.name
}
