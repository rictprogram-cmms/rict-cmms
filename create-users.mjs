/**
 * Bulk create Supabase Auth users from the profiles table
 * 
 * Usage:
 *   node create-users.mjs YOUR_SERVICE_ROLE_KEY
 * 
 * Run this from your project folder. It creates auth accounts for all
 * users listed below with the temporary password: RICTtemp2026!
 * Users can reset their password via "Forgot your password?" on the login page.
 */

const SERVICE_ROLE_KEY = process.argv[2]
if (!SERVICE_ROLE_KEY) {
  console.error('❌ Usage: node create-users.mjs YOUR_SERVICE_ROLE_KEY')
  process.exit(1)
}

const SUPABASE_URL = 'https://jzzfgafwyxabafaqrnho.supabase.co'
const TEMP_PASSWORD = 'RICTtemp2026!'

const users = [
  { email: 'brad.wanous@sctcc.edu', first_name: 'Brad', last_name: 'Wanous' },
  { email: 'b_wanous@hotmail.com', first_name: 'Brad', last_name: 'Wanous' },
  { email: 'katarina.frank@sctcc.edu', first_name: 'Katie', last_name: 'Frank' },
  { email: 'abarker@sctcc.edu', first_name: 'Aaron', last_name: 'Barker' },
  { email: 'standardjoe3@gmail.com', first_name: 'joseph', last_name: 'sabrowsky' },
  { email: 'yi1067kp@go.minnstate.edu', first_name: 'Colby', last_name: 'Faber' },
  { email: 'adam.kishimba@my.sctcc.edu', first_name: 'Adam', last_name: 'Kishimba' },
  { email: 'pogust89@my.sctcc.edu', first_name: 'Steven', last_name: 'Pogue' },
  { email: 'it0539bs@go.minnstate.edu', first_name: 'David', last_name: 'Diaz' },
  { email: 'austin.c.zahara@outlook.com', first_name: 'Austin', last_name: 'Zahara' },
  { email: 'zb3719yo@go.minnstate.edu', first_name: 'Catherine', last_name: 'Woodavens' },
  { email: 'jacob.smith.4@my.sctcc.edu', first_name: 'Jacob', last_name: 'Smith' },
  { email: 'brandon-swart@outlook.com', first_name: 'Brandon', last_name: 'Swart' },
  { email: 'garett.rea@my.sctcc.edu', first_name: 'Garett', last_name: 'Rea' },
  { email: 'mahdizty9@gmail.com', first_name: 'Mahamed', last_name: 'Mahdi' },
  { email: 'aaron@abctechllc.com', first_name: 'Aaron', last_name: 'Work Study' },
  { email: 'bp6641vv@go.minnstate.edu', first_name: 'Isaac', last_name: 'Welsh' },
  { email: 'go5636ec@go.minnstate.edu', first_name: 'Cooper', last_name: 'Erickson' },
  { email: 'nr0376wt@go.minnstate.edu', first_name: 'Evan', last_name: 'Johnson' },
  { email: 'vn1156ti@go.minnstate.edu', first_name: 'Samantha', last_name: 'Petzel' },
  { email: 'oe2174wi@go.minnstate.edu', first_name: 'Morgan', last_name: 'Zieglmeier' },
  { email: 'vq3247kh@go.minnstate.edu', first_name: 'Cassie', last_name: 'Shaffer' },
  { email: 'adam.helstrom@my.sctcc.edu', first_name: 'Adam', last_name: 'Helstrom' },
]

async function createUser(user) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      email: user.email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: {
        first_name: user.first_name,
        last_name: user.last_name,
      },
    }),
  })

  const data = await res.json()

  if (res.ok) {
    console.log(`✅ ${user.email} — created`)
  } else {
    console.log(`❌ ${user.email} — ${data.msg || data.message || JSON.stringify(data)}`)
  }
}

console.log(`Creating ${users.length} users with temp password: ${TEMP_PASSWORD}\n`)

for (const user of users) {
  await createUser(user)
}

console.log('\n🎉 Done! All users can log in with: RICTtemp2026!')
console.log('They can change their password via "Forgot your password?" on the login page.')
