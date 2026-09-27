/**
 * Built-in asset types — the IT Glue sidebar, single-tenant (pure).
 *
 * Core assets are the seven IT Glue core types with their standard fields.
 * "Apps & Services" and "Administration" are IT Glue's default flexible asset
 * types. All are seeded into the database on first run (so custom fields and
 * custom types persist); builtin fields can't be removed, builtin types can't
 * be deleted, but everything else is editable in Settings → Asset types.
 */
import type { AssetType, FieldDef, Section } from '../types'

const f = (key: string, label: string, kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({
  key,
  label,
  kind,
  builtin: true,
  ...extra
})
const notes = (): FieldDef => f('notes', 'Notes', 'markdown')

interface Def {
  id: string
  name: string
  namePlural: string
  icon: string
  section: Section
  description: string
  nameLabel?: string
  fields: FieldDef[]
}

const DEFS: Def[] = [
  /* ------------------------------ core ------------------------------ */
  {
    id: 'configuration',
    name: 'Configuration',
    namePlural: 'Configurations',
    icon: 'Server',
    section: 'core',
    description: 'Servers, workstations, network gear, printers — anything with a hostname or serial number.',
    nameLabel: 'Name / hostname',
    fields: [
      f('configType', 'Type', 'select', {
        showInList: true,
        required: true,
        options: ['Server', 'Virtual machine', 'Workstation', 'Laptop', 'Firewall', 'Switch', 'Router', 'Access point', 'Printer', 'NAS / storage', 'UPS', 'Phone', 'Camera', 'IoT device', 'Other']
      }),
      f('status', 'Status', 'select', { showInList: true, options: ['Active', 'Inactive', 'Planned', 'Retired'], defaultValue: 'Active' }),
      f('primaryIp', 'Primary IP', 'ip', { showInList: true }),
      f('mac', 'MAC address', 'text'),
      f('manufacturer', 'Manufacturer', 'text'),
      f('model', 'Model', 'text', { showInList: true }),
      f('serial', 'Serial number', 'text'),
      f('assetTag', 'Asset tag', 'text'),
      f('os', 'Operating system', 'text'),
      f('location', 'Location', 'relation', { relationType: 'location' }),
      f('contact', 'Primary contact', 'relation', { relationType: 'contact' }),
      f('gateway', 'Default gateway', 'ip'),
      f('installedAt', 'Installed', 'date'),
      f('warrantyExpires', 'Warranty expires', 'date', { expires: true }),
      f('position', 'Rack / position', 'text'),
      notes()
    ]
  },
  {
    id: 'contact',
    name: 'Contact',
    namePlural: 'Contacts',
    icon: 'Users',
    section: 'core',
    description: 'People — staff, vendors, support contacts.',
    nameLabel: 'Full name',
    fields: [
      f('title', 'Title / role', 'text', { showInList: true }),
      f('contactType', 'Type', 'select', { showInList: true, options: ['Employee', 'Manager', 'Contractor', 'Vendor', 'Client', 'Other'] }),
      f('email', 'Email', 'email', { showInList: true }),
      f('phone', 'Phone', 'phone'),
      f('mobile', 'Mobile', 'phone'),
      f('location', 'Location', 'relation', { relationType: 'location' }),
      f('important', 'Important contact', 'checkbox'),
      notes()
    ]
  },
  {
    id: 'location',
    name: 'Location',
    namePlural: 'Locations',
    icon: 'MapPin',
    section: 'core',
    description: 'Sites and offices.',
    fields: [
      f('address', 'Address', 'text', { showInList: true }),
      f('city', 'City', 'text', { showInList: true }),
      f('state', 'State / region', 'text'),
      f('zip', 'ZIP / postcode', 'text'),
      f('country', 'Country', 'text'),
      f('phone', 'Phone', 'phone'),
      f('primary', 'Primary location', 'checkbox'),
      notes()
    ]
  },
  {
    id: 'document',
    name: 'Document',
    namePlural: 'Documents',
    icon: 'FileText',
    section: 'core',
    description: 'How-tos, procedures, runbooks and notes — written in Markdown, organised in folders.',
    nameLabel: 'Title',
    fields: [f('content', 'Content', 'markdown')]
  },
  {
    id: 'password',
    name: 'Password',
    namePlural: 'Passwords',
    icon: 'KeyRound',
    section: 'core',
    description: 'Credentials, encrypted at rest. Reveal, copy or read a one-time code without leaving the app.',
    fields: [
      f('username', 'Username', 'text', { showInList: true }),
      f('password', 'Password', 'password', { showInList: true }),
      f('totp', 'One-time code (TOTP secret)', 'totp', { hint: 'Paste the setup key shown when enabling 2FA — the app then shows the rolling 6-digit code.' }),
      f('url', 'URL', 'url', { showInList: true }),
      f('category', 'Category', 'select', {
        showInList: true,
        options: ['General', 'Admin / root', 'Service account', 'Wi-Fi', 'Email', 'Website / SaaS', 'Database', 'Network device', 'Cloud', 'Banking', 'Other']
      }),
      f('configuration', 'Used on', 'relation', { relationType: 'configuration' }),
      notes()
    ]
  },
  {
    id: 'domain',
    name: 'Domain',
    namePlural: 'Domains',
    icon: 'Globe',
    section: 'core',
    description: 'Domain tracker — registrar, expiry and live DNS/WHOIS lookups.',
    nameLabel: 'Domain name',
    fields: [
      f('registrar', 'Registrar', 'text', { showInList: true }),
      f('expires', 'Expires', 'date', { expires: true, showInList: true }),
      f('autoRenew', 'Auto-renews', 'checkbox', { showInList: true }),
      f('dnsProvider', 'DNS hosted at', 'text'),
      f('registrarLogin', 'Registrar login', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'ssl',
    name: 'SSL Certificate',
    namePlural: 'SSL Certificates',
    icon: 'ShieldCheck',
    section: 'core',
    description: 'SSL tracker — check a host and record the certificate’s issuer and expiry.',
    nameLabel: 'Common name / host',
    fields: [
      f('host', 'Host to check', 'text', { showInList: true, hint: 'e.g. mail.example.com (defaults to the name)' }),
      f('port', 'Port', 'number', { defaultValue: 443 }),
      f('issuer', 'Issuer', 'text', { showInList: true }),
      f('validTo', 'Expires', 'date', { expires: true, showInList: true }),
      f('certType', 'Type', 'select', { options: ['Single', 'Wildcard', 'Multi-domain (SAN)', 'Self-signed', 'Internal CA'] }),
      f('autoRenew', 'Auto-renews (ACME / managed)', 'checkbox'),
      notes()
    ]
  },

  /* -------------------------- apps & services -------------------------- */
  {
    id: 'active-directory',
    name: 'Active Directory',
    namePlural: 'Active Directory',
    icon: 'KeySquare',
    section: 'apps',
    description: 'Domains, forest levels and domain controllers.',
    nameLabel: 'AD domain (FQDN)',
    fields: [
      f('netbios', 'NetBIOS name', 'text', { showInList: true }),
      f('forestLevel', 'Forest / domain functional level', 'text'),
      f('domainControllers', 'Domain controllers', 'relation', { relationType: 'configuration' }),
      f('fsmo', 'FSMO role holders', 'textarea'),
      f('azureAdSync', 'Entra ID / Azure AD sync', 'select', { options: ['None', 'Entra Connect (sync)', 'Cloud-only', 'Hybrid join'] }),
      f('adminCredential', 'Domain admin credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'application',
    name: 'Application',
    namePlural: 'Applications',
    icon: 'AppWindow',
    section: 'apps',
    description: 'Line-of-business and SaaS applications.',
    fields: [
      f('version', 'Version', 'text', { showInList: true }),
      f('vendor', 'Vendor', 'relation', { relationType: 'vendor' }),
      f('appType', 'Type', 'select', { showInList: true, options: ['Desktop', 'Server', 'SaaS / web', 'Mobile', 'Other'] }),
      f('url', 'URL', 'url'),
      f('installedOn', 'Installed on', 'relation', { relationType: 'configuration' }),
      f('credential', 'Admin credential', 'relation', { relationType: 'password' }),
      f('licensing', 'Licensing', 'relation', { relationType: 'licensing' }),
      f('supportContact', 'Support contact', 'relation', { relationType: 'contact' }),
      notes()
    ]
  },
  {
    id: 'backup',
    name: 'Backup',
    namePlural: 'Backups',
    icon: 'DatabaseBackup',
    section: 'apps',
    description: 'What is backed up, where, how often and how long it is kept.',
    fields: [
      f('solution', 'Backup solution', 'text', { showInList: true }),
      f('backupType', 'Type', 'select', { showInList: true, options: ['Image', 'File & folder', 'Database', 'SaaS (M365 / Google)', 'VM snapshot', 'Other'] }),
      f('protects', 'Protects', 'relation', { relationType: 'configuration' }),
      f('schedule', 'Schedule', 'text', { showInList: true }),
      f('retention', 'Retention', 'text'),
      f('target', 'Target / destination', 'text'),
      f('offsite', 'Offsite copy', 'checkbox'),
      f('lastTested', 'Last restore test', 'date'),
      f('credential', 'Console credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'email',
    name: 'Email',
    namePlural: 'Email',
    icon: 'Mail',
    section: 'apps',
    description: 'Mail platform, domains, filtering and admin access.',
    nameLabel: 'Email domain',
    fields: [
      f('platform', 'Platform', 'select', { showInList: true, options: ['Microsoft 365', 'Google Workspace', 'Exchange (on-prem)', 'IMAP / hosted', 'Other'] }),
      f('adminUrl', 'Admin portal', 'url'),
      f('spamFilter', 'Spam filtering', 'text'),
      f('mxHost', 'MX host', 'text', { showInList: true }),
      f('adminCredential', 'Admin credential', 'relation', { relationType: 'password' }),
      f('domain', 'Domain record', 'relation', { relationType: 'domain' }),
      notes()
    ]
  },
  {
    id: 'file-sharing',
    name: 'File Sharing',
    namePlural: 'File Sharing',
    icon: 'FolderOpen',
    section: 'apps',
    description: 'Shares, drives and cloud storage — paths, hosts and who has access.',
    nameLabel: 'Share name',
    fields: [
      f('shareType', 'Type', 'select', { showInList: true, options: ['SMB share', 'NAS', 'SharePoint / OneDrive', 'Google Drive', 'Dropbox', 'Other'] }),
      f('server', 'Hosted on', 'relation', { relationType: 'configuration' }),
      f('path', 'Path / URL', 'text', { showInList: true }),
      f('mappedDrive', 'Mapped drive letter', 'text'),
      f('permissions', 'Permissions', 'textarea'),
      notes()
    ]
  },
  {
    id: 'internet-wan',
    name: 'Internet / WAN',
    namePlural: 'Internet / WAN',
    icon: 'Cable',
    section: 'apps',
    description: 'ISP circuits, static IPs and who to call when the internet is down.',
    nameLabel: 'Circuit name',
    fields: [
      f('provider', 'Provider (ISP)', 'text', { showInList: true }),
      f('circuitType', 'Type', 'select', { showInList: true, options: ['Fibre', 'Cable', 'DSL', 'Fixed wireless', '5G / LTE', 'Satellite', 'MPLS', 'Other'] }),
      f('speed', 'Speed (down / up)', 'text', { showInList: true }),
      f('staticIps', 'Static IPs', 'textarea'),
      f('accountNumber', 'Account number', 'text'),
      f('supportPhone', 'Support phone', 'phone'),
      f('gateway', 'Modem / gateway', 'relation', { relationType: 'configuration' }),
      f('contractEnds', 'Contract ends', 'date', { expires: true }),
      f('portalCredential', 'Portal credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'lan',
    name: 'LAN',
    namePlural: 'LAN',
    icon: 'Network',
    section: 'apps',
    description: 'Subnets, VLANs, gateways and DHCP scopes.',
    nameLabel: 'Network name',
    fields: [
      f('subnet', 'Subnet (CIDR)', 'text', { showInList: true, required: true }),
      f('vlan', 'VLAN ID', 'number', { showInList: true }),
      f('gateway', 'Gateway', 'ip', { showInList: true }),
      f('dhcpServer', 'DHCP server', 'relation', { relationType: 'configuration' }),
      f('dhcpRange', 'DHCP range', 'text'),
      f('dnsServers', 'DNS servers', 'text'),
      f('switches', 'Switches / core', 'relation', { relationType: 'configuration' }),
      f('location', 'Location', 'relation', { relationType: 'location' }),
      notes()
    ]
  },
  {
    id: 'printing',
    name: 'Printing',
    namePlural: 'Printing',
    icon: 'Printer',
    section: 'apps',
    description: 'Printers, print servers and drivers.',
    nameLabel: 'Printer / queue name',
    fields: [
      f('printer', 'Printer device', 'relation', { relationType: 'configuration' }),
      f('printServer', 'Print server', 'relation', { relationType: 'configuration' }),
      f('ip', 'IP address', 'ip', { showInList: true }),
      f('driver', 'Driver', 'text'),
      f('location', 'Location', 'relation', { relationType: 'location' }),
      f('adminCredential', 'Web admin credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'remote-access',
    name: 'Remote Access',
    namePlural: 'Remote Access',
    icon: 'MonitorSmartphone',
    section: 'apps',
    description: 'VPNs, remote desktop gateways and remote-control tools.',
    fields: [
      f('accessType', 'Type', 'select', { showInList: true, options: ['VPN (site-to-site)', 'VPN (client)', 'RDP / RD Gateway', 'Remote control (RMM)', 'SSH', 'Web portal', 'Other'] }),
      f('address', 'Address / host', 'text', { showInList: true }),
      f('client', 'Client software', 'text'),
      f('mfa', 'MFA required', 'checkbox'),
      f('credential', 'Credential', 'relation', { relationType: 'password' }),
      f('device', 'Endpoint device', 'relation', { relationType: 'configuration' }),
      notes()
    ]
  },
  {
    id: 'virtualization',
    name: 'Virtualization',
    namePlural: 'Virtualization',
    icon: 'Boxes',
    section: 'apps',
    description: 'Hypervisor hosts and the VMs they run.',
    nameLabel: 'Host / cluster name',
    fields: [
      f('hypervisor', 'Hypervisor', 'select', { showInList: true, options: ['Hyper-V', 'VMware ESXi / vSphere', 'Proxmox', 'XCP-ng / Citrix', 'KVM', 'Other'] }),
      f('version', 'Version', 'text', { showInList: true }),
      f('host', 'Host device', 'relation', { relationType: 'configuration' }),
      f('vms', 'Virtual machines', 'relation', { relationType: 'configuration' }),
      f('storage', 'Datastores / storage', 'textarea'),
      f('mgmtUrl', 'Management URL', 'url'),
      f('credential', 'Management credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'voice-pbx',
    name: 'Voice / PBX',
    namePlural: 'Voice / PBX',
    icon: 'Phone',
    section: 'apps',
    description: 'Phone system, numbers, extensions and the carrier.',
    nameLabel: 'System name',
    fields: [
      f('provider', 'Provider / carrier', 'text', { showInList: true }),
      f('systemType', 'Type', 'select', { showInList: true, options: ['Hosted VoIP', 'On-prem PBX', 'Teams / Zoom Phone', 'Analog / PSTN', 'Other'] }),
      f('mainNumber', 'Main number', 'phone', { showInList: true }),
      f('numbers', 'Numbers / DIDs', 'textarea'),
      f('extensions', 'Extensions', 'textarea'),
      f('pbxDevice', 'PBX device', 'relation', { relationType: 'configuration' }),
      f('adminCredential', 'Admin credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'wireless',
    name: 'Wireless',
    namePlural: 'Wireless',
    icon: 'Wifi',
    section: 'apps',
    description: 'SSIDs, security and access points.',
    nameLabel: 'SSID',
    fields: [
      f('security', 'Security', 'select', { showInList: true, options: ['WPA3', 'WPA2-PSK', 'WPA2-Enterprise', 'Open', 'Other'] }),
      f('passphrase', 'Passphrase', 'password', { showInList: true }),
      f('band', 'Band', 'select', { options: ['2.4 GHz', '5 GHz', '6 GHz', 'Dual / tri-band'] }),
      f('vlan', 'VLAN', 'number'),
      f('guest', 'Guest network', 'checkbox', { showInList: true }),
      f('accessPoints', 'Access points', 'relation', { relationType: 'configuration' }),
      f('controller', 'Controller / admin credential', 'relation', { relationType: 'password' }),
      f('location', 'Location', 'relation', { relationType: 'location' }),
      notes()
    ]
  },

  /* ---------------------------- administration ---------------------------- */
  {
    id: 'licensing',
    name: 'Licensing',
    namePlural: 'Licensing',
    icon: 'FileKey',
    section: 'admin',
    description: 'Software licences, keys, seat counts and renewals.',
    nameLabel: 'Product',
    fields: [
      f('licenseKey', 'Licence key', 'password', { showInList: true }),
      f('seats', 'Seats', 'number', { showInList: true }),
      f('licenseType', 'Type', 'select', { showInList: true, options: ['Subscription', 'Perpetual', 'Volume', 'OEM', 'Open source', 'Other'] }),
      f('expires', 'Renews / expires', 'date', { expires: true, showInList: true }),
      f('cost', 'Cost per period', 'text'),
      f('vendor', 'Vendor', 'relation', { relationType: 'vendor' }),
      f('application', 'Application', 'relation', { relationType: 'application' }),
      f('portalCredential', 'Portal credential', 'relation', { relationType: 'password' }),
      notes()
    ]
  },
  {
    id: 'vendor',
    name: 'Vendor',
    namePlural: 'Vendors',
    icon: 'Building2',
    section: 'admin',
    description: 'Suppliers and service providers — account numbers and support lines.',
    fields: [
      f('website', 'Website', 'url', { showInList: true }),
      f('accountNumber', 'Account number', 'text', { showInList: true }),
      f('supportPhone', 'Support phone', 'phone', { showInList: true }),
      f('supportEmail', 'Support email', 'email'),
      f('contact', 'Account manager', 'relation', { relationType: 'contact' }),
      f('portalCredential', 'Portal credential', 'relation', { relationType: 'password' }),
      f('contractEnds', 'Contract ends', 'date', { expires: true }),
      notes()
    ]
  }
]

export const BUILTIN_TYPES: AssetType[] = DEFS.map((d, i) => ({
  id: d.id,
  name: d.name,
  namePlural: d.namePlural,
  icon: d.icon,
  section: d.section,
  fields: d.fields,
  builtin: true,
  sortOrder: i,
  description: d.description,
  nameLabel: d.nameLabel ?? 'Name',
  archived: false
}))

export const SECTIONS: { id: Section; label: string }[] = [
  { id: 'core', label: 'Core assets' },
  { id: 'apps', label: 'Apps & services' },
  { id: 'admin', label: 'Administration' }
]

export const SECRET_KINDS: FieldDef['kind'][] = ['password', 'totp']

export const isSecretKind = (k: FieldDef['kind']): boolean => SECRET_KINDS.includes(k)

/** Icons a custom type can pick from (all present in lucide-react). */
export const TYPE_ICONS = [
  'Server', 'Users', 'MapPin', 'FileText', 'KeyRound', 'Globe', 'ShieldCheck', 'KeySquare', 'AppWindow', 'DatabaseBackup', 'Mail',
  'FolderOpen', 'Cable', 'Network', 'Printer', 'MonitorSmartphone', 'Boxes', 'Phone', 'Wifi', 'FileKey', 'Building2', 'HardDrive',
  'Router', 'Laptop', 'Monitor', 'Smartphone', 'Cloud', 'Shield', 'Cpu', 'Wrench', 'Landmark', 'ScrollText', 'Notebook', 'Radio',
  'Fingerprint', 'BookOpen', 'Tag', 'Link2', 'Timer', 'Contact'
]

export const FIELD_KINDS: { kind: FieldDef['kind']; label: string }[] = [
  { kind: 'text', label: 'Text' },
  { kind: 'textarea', label: 'Multi-line text' },
  { kind: 'markdown', label: 'Rich text (Markdown)' },
  { kind: 'number', label: 'Number' },
  { kind: 'date', label: 'Date' },
  { kind: 'select', label: 'Dropdown' },
  { kind: 'checkbox', label: 'Checkbox' },
  { kind: 'url', label: 'URL' },
  { kind: 'email', label: 'Email' },
  { kind: 'phone', label: 'Phone' },
  { kind: 'ip', label: 'IP address' },
  { kind: 'password', label: 'Password (encrypted)' },
  { kind: 'totp', label: 'One-time code secret (encrypted)' },
  { kind: 'relation', label: 'Link to other records' }
]

/** kebab-case id from a label ("Internet / WAN" → "internet-wan"). */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
