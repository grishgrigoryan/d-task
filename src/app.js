const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { Op } = require("sequelize");

const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const { type, id: profileId } = (req.profile);
  const foreignKey = type === "client" ? "ClientId" : "ContractorId";
  const where = { id };
  where[ foreignKey ] = profileId;
  const contract = await Contract.findOne({ where });
  if (!contract) {
    return res.status(404).json({ message: "Contract not found" });
  }
  res.json(contract);
});

app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { type, id: profileId } = req.profile;
  const foreignKey = type === "client" ? "ClientId" : "ContractorId";
  const where = { status: { [ Op.ne ]: "terminated" } };
  where[ foreignKey ] = profileId;
  const contract = await Contract.findAll({ where });
  res.json(contract);
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models");
  const { type, id: profileId } = req.profile;
  const foreignKey = type === "client" ? "ClientId" : "ContractorId";
  const jobs = await Job.findAll({
    where: { paid: { [ Op.not ]: true } },
    include: [{
      attributes: [],
      where: {
        status: { [ Op.ne ]: "terminated" },
        [ foreignKey ]: profileId
      },
      model: Contract
    }]
  });
  res.json(jobs);
});

app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const sequelize = req.app.get("sequelize");
  const { job_id: jobId } = req.params;
  const { type, id: profileId } = req.profile;
  try {
    if (type !== "client") {
      return res.status(403).end();
    }
    const result = await sequelize.transaction(async (t) => {
      const job = await Job.findOne({
        where: { paid: { [ Op.not ]: true }, id: jobId },
        lock: true,
        skipLocked: true,
        transaction: t,
        include: [{
          where: {
            ClientId: profileId
          },
          required: true,
          model: Contract
        }]
      });
      if (!job) {
        throw new Error("Job not found for client");
      }
      const [[_, decremented]] = await Profile.decrement({ "balance": job.price }, {
        where: {
          id: profileId,
          balance: { [ Op.gte ]: job.price }
        },
        transaction: t
      });
      if (!decremented) {
        throw new Error("Client balance is less then amount to pay");
      }
      await Profile.increment({ balance: job.price }, { where: { id: job.Contract.ContractorId }, transaction: t });
      const [updated] = await Job.update({ paid: true, paymentDate: Date.now() }, { transaction: t, where: { id: jobId, paid: { [ Op.not ]: true } } });
      if (!updated) {
        throw new Error("Already paid");
      }
      return await job.reload({ transaction: t });
    });
    res.json(result);

  } catch (error) {
    res.status(400).json({ message: error.message });
  }

});

app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  try {
    const { Job, Contract, Profile } = req.app.get("models");
    const sequelize = req.app.get("sequelize");
    const { userId } = req.params;
    const deposit = req.body.deposit;
    const result = await Job.findOne({
      where: {
        paid: {
          [ Op.not ]: true
        }
      },
      attributes: [
        [sequelize.fn("sum", sequelize.col("price")), "totalUnpaid"]
      ],
      include: {
        required: true,
        model: Contract,
        attributes: [],
        where: {
          status: { [ Op.ne ]: "terminated" },
          ClientId: userId
        }
      }
    });
    const totalUnpaid = result.dataValues.totalUnpaid;
    if (!totalUnpaid) {
      throw new Error("No unpaid jobs ");
    }
    if (deposit > totalUnpaid * 0.25) {
      throw new Error(`Can't deposit more than 25% total of jobs to pay (${totalUnpaid * 0.25})`);
    }
    await Profile.increment({ balance: deposit }, { where: { id: userId } });
    console.log(totalUnpaid);
    res.json(await Profile.findByPk(userId));
  } catch (e) {
    res.json({ message: e.message }).status(400);
  }
});

app.get("/admin/best-profession", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const sequelize = req.app.get("sequelize");
  const { start, end } = req.query;
  const where = {
    paid: true
  };
  if (start && end) {
    where.paymentDate = {
      [ Op.gt ]: new Date(start),
      [ Op.lt ]: new Date(end)
    };
  }
  const result = await Job.findOne({
    where,
    attributes: [
      [sequelize.fn("sum", sequelize.col("price")), "total_amount"]
    ],
    include: {
      required: true,
      model: Contract,
      as: "Contract",
      include: {
        required: true,
        model: Profile,
        as: "Contractor"
      }
    },
    order: [["total_amount", "DESC"]],
    group: ["Contract.Contractor.profession"]
  });
  return res.json({ profession: result.Contract.Contractor.profession });
});

app.get("/admin/best-clients", getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get("models");
  const sequelize = req.app.get("sequelize");
  const { start, end, limit = 2 } = req.query;
  const where = {
    paid: true
  };
  if (start && end) {
    where.paymentDate = {
      [ Op.gt ]: new Date(start),
      [ Op.lt ]: new Date(end)
    };
  }
  const result = await Job.findAll({
    where,
    attributes: [
      [sequelize.fn("sum", sequelize.col("price")), "total_amount"]
    ],
    include: {
      required: true,
      attributes: ["ClientId"],
      model: Contract,
      include: {
        required: true,
        model: Profile,
        as: "Client"
      }
    },
    limit,
    order: [["total_amount", "DESC"]],
    group: ["Contract.Client.id"]
  });
  return res.json(result.map(r => r.Contract.Client));
});

module.exports = app;
