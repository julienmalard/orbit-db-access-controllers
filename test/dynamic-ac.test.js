'use strict'

const assert = require('assert')
const rmrf = require('rimraf')
const OrbitDB = require('orbit-db')
const IdentityProvider = require('orbit-db-identity-provider')
const Keystore = require('orbit-db-keystore')
const AccessControllers = require('../')
const ContractAccessController = require('../src/contract-access-controller')
const { open } = require('@colony/purser-software')
const Web3 = require('web3')
const fs = require('fs')
const path =require('path')
const abi = JSON.parse(fs.readFileSync(path.resolve('./test/', 'abi.json')))

// Include test utilities
const {
  config,
  startIpfs,
  stopIpfs,
  testAPIs,
} = require('./utils')

const dbPath = './orbitdb/tests/dynamic-ac'
const ipfsPath = './orbitdb/tests/dynamic-ac/ipfs'

const databases = [
  {
    type: 'key-value',
    create: (orbitdb, name, options) => orbitdb.kvstore(name, options),
    tryInsert: (db) => db.set('one', 'hello'),
    query: (db) => [],
    getTestValue: (db) => db.get('one'),
    expectedValue: 'hello',
  }
]

Object.keys(testAPIs).forEach(API => {
  describe.skip(`orbit-db - Smart Contract Permissions (${API})`, function() {
    this.timeout(20000)

    let ipfsd, ipfs, orbitdb1, orbitdb2, id1, id2, acOptions, keystore

    before(async () => {
      config.daemon1.repo = ipfsPath
      rmrf.sync(config.daemon1.repo)
      rmrf.sync(dbPath)
      keystore = Keystore.create(dbPath)
      ipfsd = await startIpfs(API, config.daemon1)
      ipfs = ipfsd.api

      const address = '0xF9d040A318c468a8AAeB5B61d73bB20b799d847D'
      const primaryAccount ='0xA3F0f20f8A2872a6A74AD802EEB9F3F6d1B966A8'

      let wallet1 = await open({
        privateKey: '0x3141592653589793238462643383279502884197169399375105820974944592'
      })

      let wallet2 = await open({
        privateKey: '0x2141592653589793238462643383279502884197169399375105820974944592'
      })

      const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://127.0.0.1:8546'))
      acOptions = Object.assign({}, 
        { web3 }, 
        { abi }, 
        { type: 'eth-contract', contractAddress: address }, 
        { primaryAccount }
      )
      // contractAPI = new ContractAPI(web3, abi, address, primaryAccount)

      const signer1 = async (id, data) => { return await wallet1.signMessage({ message: data }) }
      const signer2 = async (id, data) => { return await wallet2.signMessage({ message: data }) }

      id1 = await IdentityProvider.createIdentity(keystore, wallet1.address, { type: 'ethers', identitySignerFn: signer1 })
      id2 = await IdentityProvider.createIdentity(keystore, wallet2.address, { type: 'ethers', identitySignerFn: signer2 })

      // add contract access controller support
      const options = {
        Handler: ContractAccessController,
        web3: web3,
        abi: abi,
      }
      AccessControllers.addAccessController(options)

      orbitdb1 = await OrbitDB.createInstance(ipfs, {
        ACFactory: AccessControllers,
        acOptions: acOptions,
        directory: dbPath + '/1',
        identity: id1
      })
      orbitdb2 = await OrbitDB.createInstance(ipfs, {
        ACFactory: AccessControllers,
        acOptions: acOptions,
        directory: dbPath + '/2',
        identity: id2
      })
    })

    after(async () => {
      if(orbitdb1)
        await orbitdb1.stop()

      if(orbitdb2)
        await orbitdb2.stop()

      if (ipfsd)
        await stopIpfs(ipfsd)
    })

    describe('allows multiple peers to write to the databases', function() {
      databases.forEach(async (database) => {
        it(database.type + ' allows multiple writers', async () => {
          let options = {
            acOptions: acOptions,
            acType: 'eth-contract',
            // Set write access for both clients
            write: [
              orbitdb1.identity.id,
              orbitdb2.identity.id
            ],
          }

          const db1 = await database.create(orbitdb1, 'sync-test', options)
          options = Object.assign({}, options, { sync: true })
          const db2 = await database.create(orbitdb2, db1.address.toString(), options)

          console.log("-", db1.access.type)
          const canAppend1 = await db1.access.canAppend({ identity: orbitdb1.identity })
          const canAppend2 = await db1.access.canAppend({ identity: orbitdb2.identity })
          console.log(">", orbitdb1.identity.id, canAppend1)
          console.log(">>", orbitdb2.identity.id, canAppend2)
          assert.equal(canAppend1, false)
          assert.equal(canAppend2, false)

          await db1.access.grant('write', orbitdb1.identity.id)
          const canAppend3 = await db1.access.canAppend({ identity: orbitdb1.identity })
          const canAppend4 = await db1.access.canAppend({ identity: orbitdb2.identity })
          console.log(">", orbitdb1.identity.id, canAppend3)
          console.log(">>", orbitdb2.identity.id, canAppend4)
          assert.equal(canAppend3, true) // fails here
          assert.equal(canAppend4, false)

          // TODO remove
          await db2.access.revoke('write', orbitdb1.identity.id)

          let err
          try {
            await database.tryInsert(db1)
            await database.tryInsert(db2)
          } catch (e) {
            err = e.toString()
          }

          assert.deepEqual(database.getTestValue(db1), database.expectedValue)
          assert.equal(err, `Error: Could not append entry, key "${orbitdb2.identity.id}" is not allowed to write to the log`)

          await db2.access.grant('write', orbitdb2.identity.id)
          await database.tryInsert(db2)
          assert.deepEqual(database.getTestValue(db2), database.expectedValue)

          await db1.close()
          await db2.close()
        })
      })
    })

  })

})