terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.10.1"
    }
  }
}

variable "account_id" { type = string }
variable "hostname" { type = string }
variable "allowed_emails" {
  type = set(string)
  validation {
    condition     = length(var.allowed_emails) > 0
    error_message = "Specify at least one planner user."
  }
}

resource "cloudflare_zero_trust_access_policy" "planner" {
  account_id = var.account_id
  name       = "2do planner users"
  decision   = "allow"
  include    = [for address in sort(tolist(var.allowed_emails)) : { email = { email = address } }]
}

resource "cloudflare_zero_trust_access_application" "planner" {
  account_id       = var.account_id
  name             = "2do planner"
  type             = "self_hosted"
  session_duration = "24h"
  destinations = [
    for path in ["app", "app/*", "api", "api/*"] :
    { type = "public", uri = "${var.hostname}/${path}" }
  ]
  policies = [{ id = cloudflare_zero_trust_access_policy.planner.id, precedence = 1 }]
}

output "access_aud" { value = cloudflare_zero_trust_access_application.planner.aud }
