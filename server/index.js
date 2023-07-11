const express = require("express");
const https = require("https");
const fs = require("fs");
const mysql = require("mysql");
const moment = require("moment");
const util = require("util");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");
const app = express();
const nodemailer = require("nodemailer");
require("dotenv").config();
app.use(express.json());
app.use(cors());
//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const legalBorrowDuration = 7;

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const dbQuery = util.promisify(db.query).bind(db);

app.get("/getLendoutTimes", (req, res) => {
  const sqlQuery = "SELECT * FROM books";
  db.query(sqlQuery, (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).send(err);
    } else {
      res.send(result);
    }
  });
});

app.post("/borrow", async (req, res) => {
  try {
    //Find the book in library that *has not been* lended
    const sqlQuery = "SELECT * FROM books WHERE name = ? AND is_lent <> 1";

    // TODO - Remember to update lendee profile image url...

    let result = await dbQuery(sqlQuery, [req.body.name]);

    if (result.length === 0) {
      res.status(400).json({ error: "Invalid book to borrow!" });
      return;
    }

    let book = result[0];
    let currentDate = moment().format("YYYY-MM-DD");

    let query =
      "UPDATE books SET lendout_time = ?, is_lent = 1, return_time = NULL WHERE id = ?";
    await dbQuery(query, [currentDate, book.id]);

    res.json({ message: "Book borrowed successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
});

app.post("/return", async (req, res) => {
  try {
    const sqlQuery = "SELECT * FROM books WHERE name = ? AND is_lent <> 0";
    let result = await dbQuery(sqlQuery, [req.body.name]);

    if (result.length === 0) {
      res.status(400).json({ error: "Invalid book to return!" });
      return;
    }

    let book = result[0];
    let currentDate = moment().format("YYYY-MM-DD");

    let query =
      "UPDATE books SET return_time = ?, is_lent = 0, lendout_time = NULL WHERE id = ?";
    await dbQuery(query, [currentDate, book.id]);

    res.json({ message: "Book returned successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
});

app.get("/get_overdue", async (req, res) => {
  try {
    const sqlQuery =
      "SELECT * FROM books WHERE DATEDIFF(NOW(), lendout_time) > ?";
    let result = await dbQuery(sqlQuery, [legalBorrowDuration]);
    res
      .status(200)
      .json(
        result.length === 0
          ? { message: "There are no overdue books as of now!" }
          : result
      );
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
});

app.get("/books", async (req, res) => {
  try {
    const sqlQuery = "SELECT *, CASE WHEN DATEDIFF(CURDATE(), lendout_time) > 7 AND is_lent = 1 THEN 1 ELSE 0 END AS is_overdue FROM books";
    let result = await dbQuery(sqlQuery);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).send(err);
  }
});

app.post("/signup", async (req, res) => {
  try {
    const sqlQuery = "INSERT INTO managers (username, password) VALUES (?, ?);";
    const hashedPassword = await bcrypt.hash(req.body.password, 10);
    let result = await dbQuery(sqlQuery, [req.body.username, hashedPassword]);
    res.status(200).json({ message: "Manager registered successfully!" });
  } catch (err) {
    res.status(500).json(err);
  }
});

app.post("/login", async (req, res) => {
  try {
    const sqlQuery = "SELECT * FROM managers WHERE username = ?";
    const result = await dbQuery(sqlQuery, [req.body.username]);
    if (result.length === 0) {
      return res.status(404).json({ error: "User does not exist!" });
    }
    if (await bcrypt.compare(req.body.password, result[0].password)) {
      const token = jwt.sign({ id: result[0].id }, process.env.JWT_SECRET, {
        expiresIn: "1h", // token will expire in 1 hour
      });
      return res.status(200).json({ message: "Sucessful login!", token });
    } else {
      return res.status(403).json({ error: "Password incorrect!" });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json(err);
  }
});

function sendAlert(recipient, subject, content) {
  let transporter = nodemailer.createTransport({
    service: "163",
    auth: {
      user: process.env.EMAIL_ADDR,
      pass: process.env.EMAIL_PASS,
    },
  });

  let mailOptions = {
    from: process.env.EMAIL_ADDR,
    to: recipient,
    subject: subject,
    text: content,
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.log(err);
    } else {
      console.log("Message sent: " + info.response);
    }
  });
}

// app.post("/testmail", async (req, res) => {
//   try {
//     const sqlQuery =
//       "SELECT * FROM books WHERE DATEDIFF(NOW(), lendout_time) > ?";
//     const result = await dbQuery(sqlQuery, [legalBorrowDuration]);

//     if (result.length > 0) {
//       sendAlert(
//         "andrewyang0828@gmail.com",
//         `${result.length} book(s) are overdue!`,
//         `Dear Manager, \nThere are ${result.length} book(s) overdue, please check the library management system!`
//       );
//     }
//   } catch (err) {
//     console.log(err);
//   }
// });

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
      if (err) {
        return res.sendStatus(403);
      }
      req.user = user;
      next();
    });
  } else {
    res.sendStatus(401);
  }
};

cron.schedule("0 0 * * *", async () => {
  try {
    const sqlQuery =
      "SELECT * FROM books WHERE DATEDIFF(NOW(), lendout_time) > ?";
    const result = await dbQuery(sqlQuery, [legalBorrowDuration]);

    if (result.length > 0) {
      sendAlert(
        "andrewyang0828@gmail.com",
        `${result.length} book(s) are overdue!`,
        `Dear Manager, \nThere are ${result.length} book(s) overdue, please check the library management system!`
      );
    }
  } catch (err) {
    console.log(err);
  }
});

//Wait for deployment
// const serverConfig = {
//   key: fs.readFileSync("server.key"),
//   cert: fs.readFileSync("server.cert"),
// };

// const server = https.createServer(serverConfig, app);

app.listen(3001, () => {
  console.log("running on port 3001");
});
