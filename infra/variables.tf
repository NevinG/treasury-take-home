variable "gemini_api_key" {
  description = "Google Gemini API key (stored as an App Service setting)."
  type        = string
  sensitive   = true
}

variable "resource_group_name" {
  description = "Resource group to create."
  type        = string
  default     = "ttb-label-verify-rg"
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "eastus"
}

variable "app_name_prefix" {
  description = "Prefix for the web app + plan names (a random suffix is added)."
  type        = string
  default     = "ttb-label-verify"
}

variable "sku_name" {
  description = "App Service plan SKU. F1 = free (no always-on); B1 ≈ $13/mo."
  type        = string
  default     = "F1"
}
